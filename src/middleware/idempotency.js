// src/middleware/idempotency.js
import prisma from '../config/prisma.js';
import crypto from 'crypto';


async function checkIdempotency(req, res, next) {
    // Use Express' case-insensitive getter to find common header names
    const idempotencyKey = req.get('x-idempotency-key') || req.get('idempotency-key') || req.get('idempotency_key');
    const resourcePath = req.baseUrl + req.path;
    const method = req.method;
    const url = req.originalUrl || req.url;

    console.log(`[IDEMPOTENCY] ${method} ${url} - Checking idempotency key...`);
    console.log(`[IDEMPOTENCY] Headers received:`, {
        'x-idempotency-key': req.get('x-idempotency-key'),
        'idempotency-key': req.get('idempotency-key'),
        'idempotency_key': req.get('idempotency_key'),
        'detected-key': idempotencyKey || 'NOT_FOUND'
    });

    if (!idempotencyKey) {
        console.error(`[IDEMPOTENCY] ERROR: Missing idempotency key for ${method} ${url}`);
        console.error(`[IDEMPOTENCY] Available headers:`, Object.keys(req.headers));
        // Idempotency is required for POST /v1/orders
        return res.status(400).json({ error: 'MISSING_IDEMPOTENCY_KEY', message: 'Idempotency-Key header is required.' });
    }

    console.log(`[IDEMPOTENCY] Using key: "${idempotencyKey}" for path: ${resourcePath}`);

    try {
        const existingRecord = await prisma.idempotencyKey.findUnique({
            where: { key: idempotencyKey }
        });

        if (existingRecord) {
            console.log(`[IDEMPOTENCY] Found existing record:`, {
                key: existingRecord.key,
                resource_path: existingRecord.resource_path,
                response_code: existingRecord.response_code,
                request_hash: existingRecord.request_hash,
                created_at: existingRecord.created_at
            });

            // Check for completed transaction
            if (existingRecord.response_code >= 200 && existingRecord.response_code < 400) {
                console.log(`[IDEMPOTENCY] Returning cached successful response (status: ${existingRecord.response_code})`);
                console.log(`[IDEMPOTENCY] Cached response body:`, JSON.stringify(existingRecord.response_body, null, 2));
                // Return cached successful response
                return res.status(existingRecord.response_code).json(existingRecord.response_body);
            }
            
            // Check for conflict (concurrent processing or past failure)
            console.warn(`[IDEMPOTENCY] CONFLICT detected for key "${idempotencyKey}":`, {
                reason: existingRecord.response_code === null 
                    ? 'Request is still in progress (response_code is NULL)' 
                    : `Previous request failed with status ${existingRecord.response_code}`,
                resource_path: existingRecord.resource_path,
                created_at: existingRecord.created_at,
                request_hash: existingRecord.request_hash
            });
            
            return res.status(409).json({
                error: 'CONFLICT',
                message: 'A request with this Idempotency-Key has already been processed or is in progress.',
                details: {
                    idempotency_key: idempotencyKey,
                    existing_status: existingRecord.response_code === null ? 'IN_PROGRESS' : `FAILED_${existingRecord.response_code}`,
                    previous_path: existingRecord.resource_path,
                    created_at: existingRecord.created_at
                }
            });
        }

        console.log(`[IDEMPOTENCY] No existing record found. Creating new idempotency record...`);

        // Key not found: Start processing
        const requestHash = crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex');
        console.log(`[IDEMPOTENCY] Request hash (SHA256): ${requestHash.substring(0, 16)}...`);

        // Create a new record to mark request as pending
        const newRecord = await prisma.idempotencyKey.create({
            data: {
                key: idempotencyKey,
                resource_path: resourcePath,
                request_hash: requestHash
                // Note: response_code and response_body are NULL/PENDING until completion
            }
        });

        console.log(`[IDEMPOTENCY] Created new idempotency record:`, {
            key: newRecord.key,
            resource_path: newRecord.resource_path,
            created_at: newRecord.created_at
        });

        // Attach key to request for controller logic
        req.idempotencyKey = idempotencyKey;
        console.log(`[IDEMPOTENCY] Request approved. Proceeding to handler...`);
        next(); 

    } catch (error) {
        console.error(`[IDEMPOTENCY] ERROR in idempotency check:`, {
            message: error.message,
            stack: error.stack,
            code: error.code,
            meta: error.meta,
            idempotency_key: idempotencyKey
        });
        res.status(500).json({ 
            error: 'IDEMPOTENCY_FAILED', 
            message: 'Failed to manage request idempotency.',
            details: error.message
        });
    }
}

export default checkIdempotency;