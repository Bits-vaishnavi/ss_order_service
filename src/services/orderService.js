//************************************** */

// src/services/orderService.js

// Import Prisma client for database interaction
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
// ============================================
// WORKFLOW-3: Pricing, Promotions & Totals
// ============================================
// Add imports for totals calculation, signature generation, and shipping
import { calculateOrderTotals, generateTotalsSignature, calculateShippingCost } from './totalService.js';
// ============================================
// END WORKFLOW-3
// ============================================

const prisma = new PrismaClient();

// Get external service URLs from environment variables
const { 
  CATALOG_SERVICE_URL, 
  INVENTORY_SERVICE_URL, 
  PAYMENT_SERVICE_URL 
} = process.env;

// Validate required environment variables
if (!CATALOG_SERVICE_URL) {
  console.error('[CONFIG] ERROR: CATALOG_SERVICE_URL environment variable is not set');
}
if (!INVENTORY_SERVICE_URL) {
  console.error('[CONFIG] ERROR: INVENTORY_SERVICE_URL environment variable is not set');
}
if (!PAYMENT_SERVICE_URL) {
  console.error('[CONFIG] ERROR: PAYMENT_SERVICE_URL environment variable is not set');
}

/**
 * Calculates the total amount from a list of items returned by the Catalog Service.
 * @param {Array<Object>} pricedItems - Items array with verified product ID, quantity, and price.
 * @returns {number} The calculated total amount.
 */
//workflow-1
/*function calculateTotalAmount(pricedItems) {
  // Simple calculation: sum of (price * quantity)
  // NOTE: Tax calculation should be added here in a production system.
  return pricedItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
}*/
// ============================================
// WORKFLOW-3: Updated calculateTotalAmount to include tax and shipping
// ============================================
function calculateTotalAmount(pricedItems, taxRate = 0.05, shippingCost = 0) {
  const totals = calculateOrderTotals(pricedItems, {
    taxRate,
    shippingCost
  });
  return totals.total;
}
// ============================================
// END WORKFLOW-3
// ============================================


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

 // ============================================
 // WORKFLOW-3: Variables for totals calculation and signature
 // ============================================
 let orderTotals = null;  // Stores subtotal, tax, shipping, total breakdown
 let totalsSignature = null;  // SHA-256 hash to detect tampering
 let taxRate = 0.05; // 5% tax rate (Workflow-3) - declared at function scope
 // ============================================
 // END WORKFLOW-3
 // ============================================

 // --- 1. PRE-SAGA: VALIDATE AND PRICE ITEMS (CATALOG SERVICE) ---
 // Check if CATALOG_SERVICE_URL is defined
 if (!CATALOG_SERVICE_URL) {
   throw new Error("CATALOG_SERVICE_URL environment variable is not set");
 }
 
 let catalogUrl; // Declare outside try block for error handling
 try {
 console.log('Pre-Saga Step 1A: Calling Catalog Service to verify prices and existence...');
 
// Extract product IDs and quantities to send to Catalog Service
const productIds = orderData.items.map(item => item.productId);

console.log(`CATALOG_SERVICE_URL: ${CATALOG_SERVICE_URL}`);

// Format query string to match API: productIds=1&productIds=2 (without brackets)
const baseUrl = CATALOG_SERVICE_URL.replace(/\/$/, ''); // Remove trailing slash
const queryString = productIds.map(id => `productIds=${id}`).join('&');
catalogUrl = `${baseUrl}/products/prices?${queryString}`;

console.log(`[CATALOG] Calling: ${catalogUrl}`);

const catalogResponse = await axios.get(catalogUrl);
console.log(`DEBUG: Catalog Service response data: ${JSON.stringify(catalogResponse.data, null, 2)}`);  

 if (catalogResponse.status !== 200 || !catalogResponse.data) {
 throw new Error("Catalog service failed to verify products or pricing.");
 }

 // Transform catalog response (map of productId -> price) into items array
 // Catalog returns: { "3": 1761, "4": 4946.1 } (keys are strings)
 // We need: [{ product_id: 3, quantity: 2, price: 1761 }, ...]
 const priceMap = catalogResponse.data;
 
 // Fetch product details (SKU and product_name) for each product
 console.log('Pre-Saga Step 1B: Fetching product details (SKU and name) from Catalog Service...');
 const productDetailsPromises = productIds.map(async (productId) => {
   try {
     const productDetailUrl = `${baseUrl}/products/${productId}`;
     console.log(`[CATALOG] Fetching product details from: ${productDetailUrl}`);
     const productDetailResponse = await axios.get(productDetailUrl, {
       timeout: 10000,
       headers: {
         'Content-Type': 'application/json'
       }
     });
     if (productDetailResponse.status === 200 && productDetailResponse.data) {
       const productData = productDetailResponse.data;
       console.log(`[CATALOG] Product ${productId} details:`, JSON.stringify(productData, null, 2));
       
       // Handle both camelCase (productId) and snake_case (product_id) field names
       const sku = productData.sku || productData.SKU || null;
       const productName = productData.name || productData.productName || productData.product_name || null;
       
       if (!sku || !productName) {
         console.warn(`[CATALOG] Missing data for product ${productId} - sku: ${sku}, name: ${productName}`);
       }
       
       return {
         productId: productId,
         sku: sku,
         product_name: productName
       };
     } else {
       console.warn(`[CATALOG] Unexpected response for product ${productId}: status ${productDetailResponse.status}`);
       return {
         productId: productId,
         sku: null,
         product_name: null
       };
     }
   } catch (error) {
     console.error(`[CATALOG] Failed to fetch details for product ${productId}:`, error.message);
     if (error.response) {
       console.error(`[CATALOG] Error response:`, error.response.status, error.response.data);
     }
     // Return null values if fetch fails - we'll still create the order item
     return {
       productId: productId,
       sku: null,
       product_name: null
     };
   }
 });
 
 const productDetails = await Promise.all(productDetailsPromises);
 const productDetailsMap = {};
 productDetails.forEach(detail => {
   productDetailsMap[detail.productId] = detail;
 });
 
 // Log the product details map for debugging
 console.log(`[CATALOG] Product details map:`, JSON.stringify(productDetailsMap, null, 2));
 
 pricedItems = orderData.items.map(item => {
   const productId = item.productId;
   // Convert productId to string since JSON object keys are always strings
   const price = priceMap[String(productId)];
   
   if (price === undefined || price === null) {
     throw new Error(`Price not found for product ID: ${productId}`);
   }
   
   // Get product details (SKU and name) from the fetched details
   const details = productDetailsMap[productId] || {};
   
   // Prioritize: request SKU > fetched SKU, but ensure we have a value
   const sku = item.sku || details.sku || null;
   const productName = details.product_name || null;
   
   // Validate that we have required product information
   if (!sku) {
     console.error(`[ORDER] ERROR: SKU is null for product ${productId}. Cannot proceed without SKU.`);
     throw new Error(`SKU not found for product ID: ${productId}. Product details fetch may have failed.`);
   }
   if (!productName) {
     console.error(`[ORDER] ERROR: product_name is null for product ${productId}. Cannot proceed without product name.`);
     throw new Error(`Product name not found for product ID: ${productId}. Product details fetch may have failed.`);
   }
   
  return {
    product_id: productId,
    quantity: item.quantity,
    price: parseFloat(price),
    sku: sku, // Use SKU from request or fetched details
    product_name: productName // Use fetched product name
  };
});

 // ============================================
 // WORKFLOW-3: Pricing, Promotions & Totals
 // ============================================
 // 1B. Calculate shipping cost locally (no external service)
 const shippingCost = calculateShippingCost(pricedItems);
 
 // 1C. Calculate totals with tax and shipping (taxRate already declared at function scope)
 orderTotals = calculateOrderTotals(pricedItems, {
   taxRate,
   shippingCost
 });
 
 finalTotalAmount = orderTotals.total;
 
 // 1D. Generate totals signature (hash) to detect tampering
 totalsSignature = generateTotalsSignature(orderTotals, pricedItems);
 
 console.log(`Products verified. Totals (Workflow-3):`, {
   subtotal: orderTotals.subtotal,
   taxRate: orderTotals.taxRate,
   taxAmount: orderTotals.taxAmount,
   shippingCost: orderTotals.shippingCost,
   total: orderTotals.total,
   signature: totalsSignature
 });
 // ============================================
 // END WORKFLOW-3
 // ============================================
 
  } catch (error) {
    // If Catalog fails, we halt before starting the local transaction, no compensation needed.
    // Log the whole error object for easier debugging (includes axios response/config when available)
    console.error('Pre-Saga failed (Catalog Service Error). Halting order process.');
    
    // Enhanced error logging
    if (error.response) {
      console.error(`[CATALOG] Error response status: ${error.response.status}`);
      console.error(`[CATALOG] Error response data:`, JSON.stringify(error.response.data, null, 2));
      const errMsg = error.response.data?.message || error.response.data?.error || `HTTP ${error.response.status}`;
      throw new Error(`Pricing verification failed: ${errMsg}`);
    } else if (error.request) {
      console.error(`[CATALOG] No response received from catalog service. URL: ${catalogUrl || 'unknown'}`);
      throw new Error(`Pricing verification failed: Cannot connect to catalog service at ${catalogUrl || CATALOG_SERVICE_URL}`);
    } else {
      const errMsg = (error && error.message) ? error.message : (typeof error === 'string' ? error : JSON.stringify(error));
      throw new Error(`Pricing verification failed: ${errMsg}`);
    }
  }

  

  // --- 2. START ORDER (Local Transaction) ---
  try {
    console.log('Saga Step 1: Starting local order creation...');
    
    // Create the order with status 'PENDING', using the verified price and total
    order = await prisma.Order.create({
      data: {
         customer_id: orderData.userId, // Schema uses customer_id, not user_id
         order_total: finalTotalAmount, // Schema uses order_total, not total_amount
         order_status: 'PENDING',
         // ============================================
         // WORKFLOW-3: Store totals signature for tampering detection
         // ============================================
         totals_signature: totalsSignature, // Hash of prices, tax, shipping, discounts
         // ============================================
         // END WORKFLOW-3
         // ============================================
         // Schema relation is named 'items', not 'eci_order_items'
        items: {
          createMany: {
            data: pricedItems.map(item => ({ // Use the verified items
              product_id: item.product_id,
              quantity: item.quantity,
              unit_price: item.price, // Schema uses unit_price - Authoritative price from Catalog (Workflow-3)
              tax_rate: taxRate, // 5% tax rate (Workflow-3)
              sku: item.sku || null, // Store SKU from catalog service
              product_name: item.product_name || null, // Store product name from catalog service
            })),
          },
        },
      },
      include: {
        items: true, // Schema relation is named 'items'
      }
    });
    
    // DEBUG LOG: Log the created order object
    console.log(`DEBUG: Order object returned by DB: ${JSON.stringify(order, null, 2)}`);
    
    console.log(`Order ${order.order_id} created with status PENDING.`);

    // --- 3. RESERVE INVENTORY ---
    // Check if INVENTORY_SERVICE_URL is defined
    if (!INVENTORY_SERVICE_URL) {
      throw new Error("INVENTORY_SERVICE_URL environment variable is not set");
    }
    
    // Format payload to match inventory service: { items: [{ sku, product_id, qty }], order_id }
    const inventoryPayload = { 
      order_id: order.order_id, 
      items: pricedItems.map(item => {
        const payloadItem = {
          product_id: item.product_id, 
          qty: item.quantity // Inventory service uses 'qty', not 'quantity'
        };
        // Include SKU if available (optional but helpful)
        if (item.sku) {
          payloadItem.sku = item.sku;
        }
        return payloadItem;
      })
    };
    
    // Normalize URL - remove trailing slash if present, then add the path
    const baseUrl = INVENTORY_SERVICE_URL.replace(/\/$/, ''); // Remove trailing slash
    const inventoryUrl = `${baseUrl}/v1/inventory/reserve`;
    
    console.log('Saga Step 2: Reserving inventory...');
    console.log(`[INVENTORY] Calling: ${inventoryUrl}`);
    console.log(`[INVENTORY] Payload:`, JSON.stringify(inventoryPayload, null, 2));
    
    try {
      const inventoryResponse = await axios.post(inventoryUrl, inventoryPayload, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      console.log(`[INVENTORY] Response:`, JSON.stringify(inventoryResponse.data, null, 2));
      inventoryReserved = true;
      console.log('Inventory successfully reserved.');
    } catch (error) {
      if (error.response) {
        console.error(`[INVENTORY] Error response:`, {
          status: error.response.status,
          data: error.response.data
        });
        throw new Error(`Inventory service error (${error.response.status}): ${JSON.stringify(error.response.data)}`);
      } else if (error.request) {
        console.error(`[INVENTORY] No response received from inventory service`);
        throw new Error(`Cannot connect to inventory service at ${inventoryUrl}`);
      } else {
        throw error;
      }
    }


    // --- 4. PROCESS PAYMENT ---
    const paymentPayload = {
      orderId: String(order.order_id), // Payment service expects orderId as string
      amount: Number(order.order_total), // Convert Decimal to number
      method: orderData.paymentMethod || "DEBIT CARD" // Optional payment method
    };

    // Normalize URL - strip any existing /v1/payments or /v1 from the end to prevent duplication
    // Check if PAYMENT_SERVICE_URL is defined
    if (!PAYMENT_SERVICE_URL) {
      throw new Error("PAYMENT_SERVICE_URL environment variable is not set");
    }
    
    let paymentBaseUrl = PAYMENT_SERVICE_URL.trim();
    
    // Remove trailing slash
    paymentBaseUrl = paymentBaseUrl.replace(/\/+$/, '');
    
    // Remove any existing /v1/payments or /v1 from the end
    paymentBaseUrl = paymentBaseUrl.replace(/\/v1\/payments\/?$/, '');
    paymentBaseUrl = paymentBaseUrl.replace(/\/v1\/?$/, '');
    
    // Ensure no trailing slash
    paymentBaseUrl = paymentBaseUrl.replace(/\/+$/, '');
    
    // Payment service endpoint is /v1/payments (not /v1/payments/charge)
    const paymentUrl = `${paymentBaseUrl}/v1/payments`;

    // Prepare headers
    const headers = {
      'Content-Type': 'application/json'
    };
    
    // Add idempotency key if available
    if (orderData.idempotencyKey) {
      headers['Idempotency-Key'] = orderData.idempotencyKey;
    } else {
      // Generate idempotency key from order_id if not provided
      headers['Idempotency-Key'] = `order-${order.order_id}`;
    }

    console.log('Saga Step 3: Processing payment...');
    console.log(`[PAYMENT] Calling: ${paymentUrl}`);
    console.log(`[PAYMENT] Payload:`, JSON.stringify(paymentPayload));
    console.log(`[PAYMENT] Headers:`, JSON.stringify(headers));
    
    let paymentResponse;
    try {
      paymentResponse = await axios.post(paymentUrl, paymentPayload, {
        headers,
        timeout: 10000
      });
      console.log(`[PAYMENT] Response:`, JSON.stringify(paymentResponse.data, null, 2));
      
      // Validate payment response - payment service returns status: "SUCCESS" on success
      const paymentStatus = paymentResponse.data?.status;
      if (paymentStatus && paymentStatus !== 'SUCCESS') {
        throw new Error(`Payment failed with status: ${paymentStatus}`);
      }
      
      // If no status field, assume success if we got a 200 response
      if (!paymentStatus && paymentResponse.status === 200) {
        console.log('[PAYMENT] Payment processed successfully (no status field in response)');
      }
      
      // Extract payment_id - handle both payment_id and paymentId field names
      const paymentId = paymentResponse.data?.payment_id || 
                        paymentResponse.data?.paymentId || 
                        paymentResponse.data?.id || 
                        null;
      
      if (paymentId) {
        console.log(`[PAYMENT] Payment ID received: ${paymentId}`);
      } else {
        console.warn('[PAYMENT] Warning: payment_id not found in payment response');
        console.warn('[PAYMENT] Available fields:', Object.keys(paymentResponse.data || {}));
      }
      
      // Store payment_id in response object for later use
      paymentResponse.paymentId = paymentId;
      
      console.log('Payment successfully processed.');
    } catch (error) {
      if (error.response) {
        console.error(`[PAYMENT] Error response:`, {
          status: error.response.status,
          data: error.response.data
        });
        throw new Error(`Payment service error (${error.response.status}): ${JSON.stringify(error.response.data)}`);
      } else if (error.request) {
        console.error(`[PAYMENT] No response received from payment service`);
        throw new Error(`Cannot connect to payment service at ${paymentUrl}`);
      } else {
        throw error;
      }
    }


    // --- 5. UPDATE ORDER STATUS (Payment Success) ---
    console.log('Saga Step 4: Updating order status...');
    // Extract payment_id from payment response - handle multiple possible field names
    const paymentId = paymentResponse?.paymentId || 
                      paymentResponse?.data?.payment_id || 
                      paymentResponse?.data?.paymentId || 
                      paymentResponse?.data?.id || 
                      null;
    
    if (!paymentId) {
      console.error('[PAYMENT] CRITICAL: payment_id is null after payment processing');
      console.error('[PAYMENT] Full payment response:', JSON.stringify(paymentResponse, null, 2));
      throw new Error('Payment processing succeeded but payment_id was not returned. Cannot proceed without payment_id.');
    }
    
    // Schema doesn't have APPROVED, so we keep order_status as PENDING but update payment_status to SUCCESS
    const updateData = { 
      payment_status: 'SUCCESS',
      payment_id: String(paymentId) // Ensure it's a string and always set it
    };
    
    order = await prisma.Order.update({
      where: { order_id: order.order_id },
      data: updateData,
      include: {
        items: true, // Schema relation is named 'items'
      }
    });
    
    console.log(`[ORDER] Order ${order.order_id} updated with payment_id: ${paymentId || 'null'}`);
 
    // ============================================
    // WORKFLOW-3: Attach totals breakdown to order response
    // ============================================
    if (orderTotals) {
      order.totals = {
        subtotal: orderTotals.subtotal,
        taxRate: orderTotals.taxRate,
        taxAmount: orderTotals.taxAmount,
        shippingCost: orderTotals.shippingCost,
        total: orderTotals.total
      };
    }
    // ============================================
    // END WORKFLOW-3
    // ============================================
 
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
  
  // 1. COMPENSATION: CANCEL THE LOCAL ORDER
  // Schema doesn't have FAILED status, using CANCELLED instead
  await prisma.Order.update({
    where: { order_id: order.order_id },
    data: { order_status: 'CANCELLED' }, // Schema has: PENDING, DELIVERED, CANCELLED
  });
  console.log(`Compensation Step 1: Local Order ${order.order_id} marked as CANCELLED.`);

  // 2. COMPENSATION: UN-RESERVE INVENTORY (if reservation succeeded)
  if (inventoryReserved) {
    console.log('Compensation Step 2: Un-reserving inventory...');
    
    // We must fetch the items from the database to send them in the compensation payload
    const orderWithItems = await prisma.Order.findUnique({
        where: { order_id: order.order_id },
        // Schema relation is named 'items'
        include: { items: true }
    });
    
    // Schema relation is named 'items'
    if (orderWithItems && orderWithItems.items.length > 0) {
        const releasePayload = {
            order_id: order.order_id,
            // Map the items to match the Inventory Service's expected structure (product_id, qty)
            items: orderWithItems.items.map(item => ({
                product_id: item.product_id,
                qty: item.quantity, // Inventory service uses 'qty', not 'quantity'
            }))
        };
        
        try {
          // Check if INVENTORY_SERVICE_URL is defined
          if (!INVENTORY_SERVICE_URL) {
            throw new Error("INVENTORY_SERVICE_URL environment variable is not set");
          }
          
          // Normalize URL - remove trailing slash if present, then add the path
          const releaseBaseUrl = INVENTORY_SERVICE_URL.replace(/\/$/, '');
          const releaseUrl = `${releaseBaseUrl}/v1/inventory/release`;
          
          console.log(`[INVENTORY_RELEASE] Calling: ${releaseUrl}`);
          console.log(`[INVENTORY_RELEASE] Payload:`, JSON.stringify(releasePayload, null, 2));
          
          await axios.post(releaseUrl, releasePayload, {
            headers: {
              'Content-Type': 'application/json'
            }
          });
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