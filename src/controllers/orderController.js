    // src/controllers/orderController.js
    import { createOrderSaga } from '../services/orderService.js';
    import { PrismaClient } from '@prisma/client'; 
    // We explicitly instantiate the Prisma client here to ensure it is available for all functions.
    const prisma = new PrismaClient();
    // Helper to save final idempotency status
    async function finalizeIdempotency(key, code, body) {
            if (!key) {
                console.warn(`[IDEMPOTENCY_FINALIZE] WARNING: No idempotency key provided, skipping finalization`);
                return;
            }
            
            console.log(`[IDEMPOTENCY_FINALIZE] Finalizing key "${key}" with status ${code}`);
            
            try {
                // Prisma model defines the PK column as `key` (see schema.prisma).
                // response_body is a Json column so store the object directly.
                const updated = await prisma.idempotencyKey.update({
                    where: { key },
                    data: {
                        response_code: code,
                        response_body: body,
                    },
                });
                
                console.log(`[IDEMPOTENCY_FINALIZE] Successfully updated idempotency record:`, {
                    key: updated.key,
                    response_code: updated.response_code,
                    updated_at: updated.created_at
                });
            } catch (error) {
                console.error(`[IDEMPOTENCY_FINALIZE] ERROR: Failed to finalize idempotency key "${key}":`, {
                    message: error.message,
                    stack: error.stack,
                    code: error.code,
                    meta: error.meta
                });
                // Don't throw - we don't want to fail the request if idempotency finalization fails
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
        const requestStartTime = Date.now();
        const { userId, items } = req.body;
        
        // Prefer the middleware-attached idempotency key; fall back to raw headers if needed.
        const idempotencyKey = req.idempotencyKey || req.headers["x-idempotency-key"] || req.headers["idempotency-key"];
        const orderData = { 
            userId, 
            items,
            idempotencyKey: idempotencyKey  // Pass idempotency key to saga
        };

        console.log(`[CREATE_ORDER] Request received:`, {
            idempotency_key: idempotencyKey,
            user_id: userId,
            items_count: items?.length || 0,
            items: items?.map(item => ({ sku: item.sku, qty: item.qty || item.quantity })) || []
        });

        if (!userId || !items || items.length === 0) {
            console.error(`[CREATE_ORDER] Validation failed:`, {
                has_userId: !!userId,
                has_items: !!items,
                items_length: items?.length || 0
            });
            return res.status(400).json({ error: 'INVALID_REQUEST', message: 'Missing userId or items.' });
        }

        try {
            console.log(`[CREATE_ORDER] Starting order creation saga with idempotency key: "${idempotencyKey}"`);
            
            // --- Call the Order Creation Saga (Business Logic) ---
            const approvedOrder = await createOrderSaga(orderData);
            
            const processingTime = Date.now() - requestStartTime;
            console.log(`[CREATE_ORDER] SUCCESS: Order ${approvedOrder.order_id} created in ${processingTime}ms`);
            console.log(`[CREATE_ORDER] Order details:`, {
                order_id: approvedOrder.order_id,
                customer_id: approvedOrder.customer_id,
                order_status: approvedOrder.order_status,
                payment_status: approvedOrder.payment_status,
                order_total: approvedOrder.order_total,
                items_count: approvedOrder.items?.length || 0
            });
            
            // Saga succeeded and returned the final APPROVED order
            // Note: totals breakdown is already included in approvedOrder from the saga (Workflow-3)
            await finalizeIdempotency(idempotencyKey, 201, approvedOrder);
            console.log(`[CREATE_ORDER] Idempotency finalized with status 201 for key: "${idempotencyKey}"`);
            
            return res.status(201).json(approvedOrder);

        } catch (error) {
            const processingTime = Date.now() - requestStartTime;
            console.error(`[CREATE_ORDER] FAILED after ${processingTime}ms:`, {
                error_message: error.message,
                error_stack: error.stack,
                error_name: error.name,
                order_id: error.order_id || 'N/A',
                idempotency_key: idempotencyKey
            });
            
            // This is the error thrown by the Saga, usually after compensation is run.
            const failureResponse = { 
                error: 'ORDER_CREATION_FAILED', 
                message: error.message || 'The order workflow failed during an external call or compensation.',
                order_id: error.order_id // If the error object contains the ID
            };
            
            console.log(`[CREATE_ORDER] Finalizing idempotency with failure status for key: "${idempotencyKey}"`);
            await finalizeIdempotency(idempotencyKey, 500, failureResponse);
            console.log(`[CREATE_ORDER] Idempotency finalized. Returning error response to client.`);
            
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
