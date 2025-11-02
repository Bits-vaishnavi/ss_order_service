//************************************** */

// src/services/orderService.js

// Import Prisma client for database interaction
import { PrismaClient } from '@prisma/client';
import axios from 'axios';

const prisma = new PrismaClient();

// Get external service URLs from environment variables
const { 
  CATALOG_SERVICE_URL, 
  INVENTORY_SERVICE_URL, 
  PAYMENT_SERVICE_URL 
} = process.env;

/**
 * Calculates the total amount from a list of items returned by the Catalog Service.
 * @param {Array<Object>} pricedItems - Items array with verified product ID, quantity, and price.
 * @returns {number} The calculated total amount.
 */
function calculateTotalAmount(pricedItems) {
  // Simple calculation: sum of (price * quantity)
  // NOTE: Tax calculation should be added here in a production system.
  return pricedItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
}


/**
 * Creates a new order using the Saga pattern with compensation logic.
 *
 * @param {object} orderData - The data for the new order (e.g., userId, items).
 * @returns {object} The finalized or failed order.
 */
export async function createOrderSaga(orderData) {
 let order; // Will hold the created order object
 let inventoryReserved = false;
 let finalTotalAmount = 0;
 let pricedItems = [];

 // --- 1. PRE-SAGA: VALIDATE AND PRICE ITEMS (CATALOG SERVICE) ---
 try {
 console.log('Pre-Saga Step 1A: Calling Catalog Service to verify prices and existence...');
 
// Extract product IDs and quantities to send to Catalog Service
const productIds = orderData.items.map(item => item.productId);

const catalogResponse = await axios.get(`${CATALOG_SERVICE_URL}/products/prices`, {
  params: { productIds: productIds } 
});
console.log(`DEBUG: Catalog Service response data: ${JSON.stringify(catalogResponse.data, null, 2)}`);  

 if (catalogResponse.status !== 200 || !catalogResponse.data.items) {
 throw new Error("Catalog service failed to verify products or pricing.");
 }
 
 pricedItems = catalogResponse.data.items;
 finalTotalAmount = calculateTotalAmount(pricedItems);
 
 console.log(`Products verified. Final calculated total: ${finalTotalAmount}`);
 
  } catch (error) {
    // If Catalog fails, we halt before starting the local transaction, no compensation needed.
    // Log the whole error object for easier debugging (includes axios response/config when available)
    console.error('Pre-Saga failed (Catalog Service Error). Halting order process.', error && error.stack ? error.stack : error);
    const errMsg = (error && error.message) ? error.message : (typeof error === 'string' ? error : JSON.stringify(error));
    throw new Error(`Pricing verification failed: ${errMsg}`);
  }

  // --- 2. START ORDER (Local Transaction) ---
  try {
    console.log('Saga Step 1: Starting local order creation...');
    
    // FIX: Changed prisma.Order to the specific model name: prisma.Order
    // Create the order with status 'PENDING', using the verified price and total
    order = await prisma.Order.create({
      data: {
        user_id: orderData.userId,
        total_amount: finalTotalAmount, // Use the verified total
        order_status: 'PENDING',
        // FIX: Changed 'items' relation name to the specific model name: 'eci_order_items'
        eci_order_items: {
          createMany: {
            data: pricedItems.map(item => ({ // Use the verified items
              product_id: item.product_id,
              quantity: item.quantity,
              unit_price: item.price, // Changed 'price' to 'unit_price' to match your schema
              // Ensure any other required fields for eci_order_items are added here if needed
            })),
          },
        },
      },
      include: {
        eci_order_items: true,
      }
    });
    
    // DEBUG LOG: Log the created order object
    console.log(`DEBUG: Order object returned by DB: ${JSON.stringify(order, null, 2)}`);
    
    console.log(`Order ${order.order_id} created with status PENDING.`);

    // --- 3. RESERVE INVENTORY ---
    const inventoryPayload = { 
      orderId: order.order_id, 
      items: pricedItems.map(item => ({ 
        productId: item.product_id, 
        quantity: item.quantity 
      }))
    };
    
    console.log('Saga Step 2: Reserving inventory...');
    await axios.post(`${INVENTORY_SERVICE_URL}/reserve`, inventoryPayload);
    inventoryReserved = true;
    console.log('Inventory successfully reserved.');


    // --- 4. PROCESS PAYMENT ---
    const paymentPayload = {
      // FIX: Ensure key names match what the Payment Service expects (order_id/userId)
      order_id: order.order_id,
      userId: order.user_id,
      amount: order.total_amount,
    };

    console.log('Saga Step 3: Processing payment...');
    // FIX: Updated endpoint from /process to /v1/payments/charge to match Payment Service
    await axios.post(`${PAYMENT_SERVICE_URL}/v1/payments/charge`, paymentPayload);
    console.log('Payment successfully processed.');


    // --- 5. APPROVE ORDER (Saga Success) ---
    console.log('Saga Step 4: Finalizing order status to APPROVED.');
    // FIX: Changed prisma.Order to the specific model name: prisma.Order
    order = await prisma.Order.update({
 where: { order_id: order.order_id },
data: { order_status: 'APPROVED' },
 // Re-fetch the updated order with its items to return the complete object
 include: {
 eci_order_items: true,
}
});
 
 return order;

} catch (error) {
 console.error(`Saga failed at a step. Initiating compensation for Order ${order?.order_id}.`, error.message);

 // --- COMPENSATION LOGIC ---
 // Added the order object to the error so the controller can log the failed ID
error.order_id = order?.order_id; 
await compensateOrder(order, inventoryReserved, error);
 
// Throw error up to the controller to return a 500 status to the client
 throw new Error(`Order processing failed: ${error.message}`);
 }
}

/**
 * Executes compensation steps based on which part of the saga failed.
 * @param {object} order - The created order object.
 * @param {boolean} inventoryReserved - True if inventory was reserved successfully.
 * @param {Error} originalError - The error that triggered the compensation.
 */
async function compensateOrder(order, inventoryReserved, originalError) {
  if (!order) {
console.error('Compensation skipped: Order was not created successfully.');
    return;
  }
  
  // 1. COMPENSATION: FAIL THE LOCAL ORDER
  // FIX: Changed prisma.Order to the specific model name: prisma.Order
  await prisma.Order.update({
    where: { order_id: order.order_id },
    data: { order_status: 'FAILED', failure_reason: originalError.message || 'Saga failed' },
  });
  console.log(`Compensation Step 1: Local Order ${order.order_id} marked as FAILED.`);

  // 2. COMPENSATION: UN-RESERVE INVENTORY (if reservation succeeded)
  if (inventoryReserved) {
    console.log('Compensation Step 2: Un-reserving inventory...');
    
    // We must fetch the items from the database to send them in the compensation payload
    // FIX: Changed prisma.Order to the specific model name: prisma.Order
    const orderWithItems = await prisma.Order.findUnique({
        where: { order_id: order.order_id },
        // FIX: Changed 'items' relation name to the specific model name: 'eci_order_items'
        include: { eci_order_items: true }
    });
    
    // FIX: Changed 'items' property access to 'eci_order_items'
    if (orderWithItems && orderWithItems.eci_order_items.length > 0) {
        const releasePayload = {
            order_id: order.order_id,
            // Map the items to match the Inventory Service's expected structure (product_id, qty)
            // FIX: Changed 'items' property access to 'eci_order_items'
            items: orderWithItems.eci_order_items.map(item => ({
                product_id: item.product_id,
                qty: item.quantity, // Inventory service uses 'qty', not 'quantity'
            }))
        };
        
        try {
          // FIX: Updated endpoint from /unreserve to /v1/inventory/release
          await axios.post(`${INVENTORY_SERVICE_URL}/v1/inventory/release`, releasePayload);
          console.log('Inventory successfully released (compensated).');
        } catch (compensationError) {
          // IMPORTANT: Log but DO NOT throw, as we want to return the original error.
          console.error(
            `CRITICAL: Failed to release inventory for Order ${order.order_id}. Manual intervention required.`,
            compensationError.message
          );
        }
    } else {
        console.warn(`Compensation warning: No items found for Order ${order.order_id}, skipping inventory release.`);
    }
  }
}
// // src/services/orderService.js

// // Import Prisma client for database interaction
// import { PrismaClient } from '@prisma/client';
// import axios from 'axios';

// const prisma = new PrismaClient();

// // Get external service URLs from environment variables
// const { 
//   CATALOG_SERVICE_URL, 
//   INVENTORY_SERVICE_URL, 
//   PAYMENT_SERVICE_URL 
// } = process.env;

// /**
//  * Calculates the total amount from a list of items returned by the Catalog Service.
//  * @param {Array<Object>} pricedItems - Items array with verified product ID, quantity, and price.
//  * @returns {number} The calculated total amount.
//  */
// function calculateTotalAmount(pricedItems) {
//   // Simple calculation: sum of (price * quantity)
//   // NOTE: Tax calculation should be added here in a production system.
//   return pricedItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
// }


// /**
//  * Creates a new order using the Saga pattern with compensation logic.
//  *
//  * @param {object} orderData - The data for the new order (e.g., userId, items).
//  * @returns {object} The finalized or failed order.
//  */
// export async function createOrderSaga(orderData) {
//   let order; // Will hold the created order object
//   let inventoryReserved = false;
//   let finalTotalAmount = 0;
//   let pricedItems = [];

//   // --- 1. PRE-SAGA: VALIDATE AND PRICE ITEMS (CATALOG SERVICE) ---
//   try {
//     console.log('Pre-Saga Step 1A: Calling Catalog Service to verify prices and existence...');
    
//     // Extract product IDs and quantities to send to Catalog Service
//     const itemDetails = orderData.items.map(item => ({ 
//         product_id: item.productId, 
//         quantity: item.quantity 
//     }));
    
//     // Assume the Catalog Service has an endpoint to verify and return current prices
//     const catalogResponse = await axios.post(`${CATALOG_SERVICE_URL}/verify-pricing`, { 
//         items: itemDetails
//     });

//     if (catalogResponse.status !== 200 || !catalogResponse.data.items) {
//         throw new Error("Catalog service failed to verify products or pricing.");
//     }
    
//     pricedItems = catalogResponse.data.items;
//     finalTotalAmount = calculateTotalAmount(pricedItems);
    
//     console.log(`Products verified. Final calculated total: ${finalTotalAmount}`);
    
//   } catch (error) {
//     // If Catalog fails, we halt before starting the local transaction, no compensation needed.
//     console.error('Pre-Saga failed (Catalog Service Error). Halting order process.', error.message);
//     throw new Error(`Pricing verification failed: ${error.message}`);
//   }

//   // --- 2. START ORDER (Local Transaction) ---
//   try {
//     console.log('Saga Step 1: Starting local order creation...');
    
//     // Create the order with status 'PENDING', using the verified price and total
//     order = await prisma.Order.create({
//       data: {
//         user_id: orderData.userId,
//         total_amount: finalTotalAmount, // Use the verified total
//         order_status: 'PENDING',
//         eci_order_items: {
//           createMany: {
//             data: pricedItems.map(item => ({ // Use the verified items
//               product_id: item.product_id,
//               quantity: item.quantity,
//               price: item.price,
//             })),
//           },
//         },
//       },
//       include: {
//         eci_order_items: true,
//       }
//     });
//     console.log(`Order ${order.order_id} created with status PENDING.`);

//     // --- 3. RESERVE INVENTORY ---
//     const inventoryPayload = { 
//       orderId: order.order_id, 
//       items: pricedItems.map(item => ({ 
//         productId: item.product_id, 
//         quantity: item.quantity 
//       }))
//     };
    
//     console.log('Saga Step 2: Reserving inventory...');
//     await axios.post(`${INVENTORY_SERVICE_URL}/reserve`, inventoryPayload);
//     inventoryReserved = true;
//     console.log('Inventory successfully reserved.');


//     // --- 4. PROCESS PAYMENT ---
//     const paymentPayload = {
//       orderId: order.order_id,
//       userId: order.user_id,
//       amount: order.total_amount,
//     };

//     console.log('Saga Step 3: Processing payment...');
//     await axios.post(`${PAYMENT_SERVICE_URL}/process`, paymentPayload);
//     console.log('Payment successfully processed.');


//     // --- 5. APPROVE ORDER (Saga Success) ---
//     console.log('Saga Step 4: Finalizing order status to APPROVED.');
//     order = await prisma.Order.update({
//       where: { order_id: order.order_id },
//       data: { order_status: 'APPROVED' },
//     });
    
//     return order;

//   } catch (error) {
//     console.error(`Saga failed at a step. Initiating compensation for Order ${order?.order_id}.`, error.message);

//     // --- COMPENSATION LOGIC ---
//     await compensateOrder(order, inventoryReserved, error);
    
//     // Throw error up to the controller to return a 500 status to the client
//     throw new Error(`Order processing failed: ${error.message}`);
//   }
// }

// /**
//  * Executes compensation steps based on which part of the saga failed.
//  * @param {object} order - The created order object.
//  * @param {boolean} inventoryReserved - True if inventory was reserved successfully.
//  * @param {Error} originalError - The error that triggered the compensation.
//  */
// async function compensateOrder(order, inventoryReserved, originalError) {
//   if (!order) {
//     console.error('Compensation skipped: Order was not created successfully.');
//     return;
//   }
  
//   // 1. COMPENSATION: FAIL THE LOCAL ORDER
//   await prisma.Order.update({
//     where: { order_id: order.order_id },
//     data: { order_status: 'FAILED', failure_reason: originalError.message || 'Saga failed' },
//   });
//   console.log(`Compensation Step 1: Local Order ${order.order_id} marked as FAILED.`);

//   // 2. COMPENSATION: UN-RESERVE INVENTORY (if reservation succeeded)
//   if (inventoryReserved) {
//     console.log('Compensation Step 2: Un-reserving inventory...');
    
//     // We must fetch the items from the database to send them in the compensation payload
//     const orderWithItems = await prisma.Order.findUnique({
//         where: { order_id: order.order_id },
//         include: { eci_order_items: true }
//     });
    
//     if (orderWithItems && orderWithItems.eci_order_items.length > 0) {
//         const releasePayload = {
//             order_id: order.order_id,
//             // Map the items to match the Inventory Service's expected structure (product_id, qty)
//             items: orderWithItems.eci_order_items.map(item => ({
//                 product_id: item.product_id,
//                 qty: item.quantity, // Inventory service uses 'qty', not 'quantity'
//             }))
//         };
        
//         try {
//           // FIX: Updated endpoint from /unreserve to /v1/inventory/release
//           await axios.post(`${INVENTORY_SERVICE_URL}/v1/inventory/release`, releasePayload);
//           console.log('Inventory successfully released (compensated).');
//         } catch (compensationError) {
//           // IMPORTANT: Log but DO NOT throw, as we want to return the original error.
//           console.error(
//             `CRITICAL: Failed to release inventory for Order ${order.order_id}. Manual intervention required.`,
//             compensationError.message
//           );
//         }
//     } else {
//         console.warn(`Compensation warning: No items found for Order ${order.order_id}, skipping inventory release.`);
//     }
//   }
// }