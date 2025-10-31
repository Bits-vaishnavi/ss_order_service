// src/server.js

import express from 'express';
import 'dotenv/config'; 
// Import your new order router
import orderRoutes from './routes/orderRoutes.js'; 

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json()); // Middleware to parse JSON body

// Health Check Endpoint (essential for Docker healthcheck)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'UP', service: 'Order Service' });
});

// Use the Order Routes, typically under a versioned prefix
app.use('/v1/orders', orderRoutes);


// Global Error Handler (Good practice)
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong.' });
});


async function main() {
  // NOTE: We no longer check DB connection here, as it's handled implicitly 
  // by Prisma or the Saga on first request/startup.
  
  app.listen(PORT, () => {
    console.log(`Order Service listening on port ${PORT}`);
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
