// src/middleware/idempotency.js
import prisma from '../config/prisma.js';
import crypto from 'crypto';


async function checkIdempotency(req, res, next) {
    const idempotencyKey = req.headers['idempotency-key'];
    const resourcePath = req.baseUrl + req.path;

    if (!idempotencyKey) {
        // Idempotency is required for POST /v1/orders
        return res.status(400).json({ error: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header is required.' });
    }

    try {
        const existingRecord = await prisma.idempotencyKey.findUnique({
            where: { key: idempotencyKey }
        });

        if (existingRecord) {
            // Check for completed transaction
            if (existingRecord.response_code >= 200 && existingRecord.response_code < 400) {
                // Return cached successful response
                return res.status(existingRecord.response_code).json(existingRecord.response_body);
            }
            // Check for conflict (concurrent processing or past failure)
            return res.status(409).json({
                error: 'CONFLICT',
                message: 'A request with this Idempotency-Key has already been processed or is in progress.'
            });
        }

        // Key not found: Start processing
        const requestHash = crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex');

        // Create a new record to mark request as pending
        await prisma.idempotencyKey.create({
            data: {
                key: idempotencyKey,
                resource_path: resourcePath,
                request_hash: requestHash
                // Note: response_code and response_body are NULL/PENDING until completion
            }
        });

        // Attach key to request for controller logic
        req.idempotencyKey = idempotencyKey;
        next(); 

    } catch (error) {
        console.error('Idempotency check failed:', error);
        res.status(500).json({ error: 'IDEMPOTENCY_FAILED', message: 'Failed to manage request idempotency.' });
    }
}

export default checkIdempotency;