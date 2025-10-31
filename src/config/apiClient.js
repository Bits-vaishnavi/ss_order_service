// src/config/apiClient.js
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config();

// Client for the Catalog Service
const catalogClient = axios.create({
    baseURL: process.env.CATALOG_SERVICE_URL,
    timeout: 5000,
});

// Client for the Inventory Service
const inventoryClient = axios.create({
    baseURL: process.env.INVENTORY_SERVICE_URL,
    timeout: 8000,
});

// Client for the Payment Service
const paymentClient = axios.create({
    baseURL: process.env.PAYMENT_SERVICE_URL,
    timeout: 10000,
});

module.exports = {
    catalogClient,
    inventoryClient,
    paymentClient
};