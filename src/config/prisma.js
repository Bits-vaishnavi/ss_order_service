// src/config/prisma.js

import { PrismaClient } from '@prisma/client';
// Initialize Prisma Client
const prisma = new PrismaClient({
    log: ['query', 'info', 'warn', 'error'],
});

export default prisma;