    // src/controllers/orderController.js
    import { createOrderSaga } from '../services/orderService.js';
    import { PrismaClient } from '@prisma/client'; 
    // We explicitly instantiate the Prisma client here to ensure it is available for all functions.
    const prisma = new PrismaClient();
    // Helper to save final idempotency status
    async function finalizeIdempotency(key, code, body) {
        if (!key) return;
        try {
            await prisma.idempotencyKey.update({
                where: { key_value: key }, // Use key_value field name
                data: {
                    response_code: code,
                    response_body: JSON.stringify(body),
                },
            });
        } catch (error) {
            console.error("Failed to finalize idempotency key:", error.message);
        }
    }

    // ------------------------------------
    // 1. GET /v1/orders/:id
    // ------------------------------------
    export async function getOrderById(req, res) {
        try {
            const orderId = parseInt(req.params.id);
            const order = await prisma.Order.findUnique({
                where: { order_id: orderId },
                include: { items: true } // Eager load order items
            });

            if (!order) {
                return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: `Order ${orderId} not found.` });
            }

            res.json(order);
        } catch (error) {
            console.error('Error fetching order by ID:', error);
            res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Could not fetch order.' });
        }
    }

    // ------------------------------------
    // 2. GET /v1/orders (Listing/Search)
    // ------------------------------------
    export async function listOrders(req, res) {
        try {
            // Simple listing; production version would add pagination/filtering
            const orders = await prisma.Order.findMany({
                include: { items: true },
                take: 50,
                orderBy: { created_at: 'desc' }
            });
            res.json(orders);
        } catch (error) {
            console.error('Error listing orders:', error);
            res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Could not list orders.' });
        }
    }

    // ------------------------------------
    // 3. POST /v1/orders (Order Creation Saga)
    // ------------------------------------
    export async function createOrder(req, res) {
        const { userId, items } = req.body;
        const idempotencyKey = req.headers["x-idempotency-key"] || req.headers["idempotency-key"];
        const orderData = { userId, items }; // Data passed to the saga

        if (!userId || !items || items.length === 0) {
            return res.status(400).json({ error: 'INVALID_REQUEST', message: 'Missing userId or items.' });
        }

        try {
            // --- Call the Order Creation Saga (Business Logic) ---
            const approvedOrder = await createOrderSaga(orderData);
            
            // Saga succeeded and returned the final APPROVED order
            await finalizeIdempotency(idempotencyKey, 201, approvedOrder);
            return res.status(201).json(approvedOrder);

        } catch (error) {
            console.error('Order creation failed:', error.message);
            
            // This is the error thrown by the Saga, usually after compensation is run.
            const failureResponse = { 
                error: 'ORDER_CREATION_FAILED', 
                message: error.message || 'The order workflow failed during an external call or compensation.',
                order_id: error.order_id // If the error object contains the ID
            };
            
            await finalizeIdempotency(idempotencyKey, 500, failureResponse); 
            return res.status(500).json(failureResponse);
        }
    }





    // // src/controllers/orderController.js
    // import { createOrderSaga } from '../services/orderService.js';
    // import { PrismaClient } from '@prisma/client';
    // // Note: Using a standard client instance here for the simple GET/LIST methods
    // const prisma = new PrismaClient();

    // // Helper to save final idempotency status (If middleware isn't handling it)
    // // NOTE: I've included this helper but removed its usage from createOrder 
    // // since all transaction logic moved to the service layer.
    // async function finalizeIdempotency(key, code, body) {
    //     if (!key) return;
    //     try {
    //         await prisma.idempotencyKey.update({
    //             where: { key },
    //             data: {
    //                 response_code: code,
    //                 response_body: JSON.stringify(body),
    //             },
    //         });
    //     } catch (e) {
    //         console.error('Failed to finalize idempotency record:', e.message);
    //     }
    // }


    // // ------------------------------------
    // // 1. GET /v1/orders/:id
    // // ------------------------------------
    // async function getOrderById(req, res) {
    //     try {
    //         const orderId = parseInt(req.params.id);
    //         const order = await prisma.Order.findUnique({
    //             where: { order_id: orderId },
    //             // Note: Using the correct table/model names (Order, items)
    //             include: { items: true } 
    //         });

    //         if (!order) {
    //             return res.status(404).json({ error: 'ORDER_NOT_FOUND', message: `Order ${orderId} not found.` });
    //         }

    //         res.json(order);
    //     } catch (error) {
    //         console.error('Error fetching order:', error);
    //         res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Could not fetch order.' });
    //     }
    // }

    // // ------------------------------------
    // // 2. GET /v1/orders (Listing/Search)
    // // ------------------------------------
    // async function listOrders(req, res) {
    //     const page = parseInt(req.query.page) || 1;
    //     const limit = parseInt(req.query.limit) || 20;
    //     const offset = (page - 1) * limit;

    //     const where = {};
    //     if (req.query.customer_id) where.user_id = parseInt(req.query.customer_id); // using user_id for customer
    //     if (req.query.status) where.order_status = req.query.status.toUpperCase(); 

    //     try {
    //         const [orders, total] = await prisma.$transaction([
    //             prisma.Order.findMany({
    //                 where,
    //                 skip: offset,
    //                 take: limit,
    //                 orderBy: { created_at: 'desc' },
    //             }),
    //             prisma.Order.count({ where }),
    //         ]);

    //         res.json({
    //             data: orders,
    //             total,
    //             page,
    //             limit,
    //             totalPages: Math.ceil(total / limit),
    //         });
    //     } catch (error) {
    //         console.error('Error listing orders:', error);
    //         res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Could not list orders.' });
    //     }
    // }

    // // ------------------------------------
    // // 3. POST /v1/orders (Creation using SAGA)
    // // ------------------------------------
    // async function createOrder(req, res) {
    //     // Assuming the request body contains all necessary data for the Saga
    //     const { userId, items, totalAmount } = req.body;
    //     const idempotencyKey = req.idempotencyKey; // Still use this if middleware is defined

    //     if (!userId || !items || items.length === 0 || totalAmount === undefined) {
    //         return res.status(400).json({ error: 'MISSING_DATA', message: 'Missing required fields: userId, items, totalAmount.' });
    //     }
        
    //     // NOTE: In a real system, we would calculate totalAmount and fetch prices 
    //     // from Catalog Service inside the Saga, not trust the client.
        
    //     const orderData = { userId, items, totalAmount, idempotencyKey };

    //     try {
    //         // --- CALL THE SAGA SERVICE ---
    //         const finalOrder = await createOrderSaga(orderData);
            
    //         // Success response
    //         return res.status(201).json({ 
    //             message: 'Order successfully created and processed.', 
    //             order: finalOrder 
    //         });

    //     } catch (error) {
    //         // This catches the error thrown from the saga, which should have triggered compensation
    //         console.error('Order creation failed:', error.message);
            
    //         const failureResponse = { 
    //             error: 'ORDER_CREATION_FAILED', 
    //             message: error.message || 'The distributed order workflow failed. Check order status for compensation details.' 
    //         };
            
    //         // Finalize Idempotency Record (Failure - typically handled in a middleware or service)
    //         // finalizeIdempotency(idempotencyKey, 500, failureResponse); 

    //         return res.status(500).json(failureResponse);
    //     }
    // }

    // export {
    //     getOrderById,
    //     listOrders,
    //     createOrder,
    // };
