// src/routes/orderRoutes.js
import express from 'express'; 
import { getOrderById, listOrders, createOrder } from '../controllers/orderController.js'; 
// Assuming you have an idempotency middleware
import checkIdempotency from '../middleware/idempotency.js'; // Use import

const router = express.Router();

// Public APIs
router.get('/', listOrders);             // GET /v1/orders
router.get('/:id', getOrderById);        // GET /v1/orders/:id

// Write API - requires idempotency check
router.post('/', checkIdempotency, createOrder); // POST /v1/orders

export default router; // Change: Use ES Module export
