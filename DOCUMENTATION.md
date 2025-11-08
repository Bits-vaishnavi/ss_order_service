# Order Service Documentation

## 1. Purpose
The Order Service is a microservice responsible for managing and processing orders within the e-commerce system. It handles order creation, retrieval, and management while ensuring idempotency and proper transaction handling.

## 2. Implementation Details

### Technology Stack
- Node.js
- Express.js
- MySQL Database
- Prisma ORM
- Docker for containerization

### Key Components
- **Server**: Express.js application with middleware for error handling and request validation
- **Controllers**: Handle business logic and request processing
- **Services**: Contain core business logic and database operations
- **Routes**: Define API endpoints and their handlers
- **Middleware**: Includes idempotency checking for safe order creation
- **Utils**: Helper functions for calculations and data processing

### Architecture
The service follows a layered architecture:
```
Routes → Controllers → Services → Database
```

## 3. API Endpoints

### Base URL: `/v1`

#### 1. Health Check
- **Path**: `/health`
- **Method**: GET
- **Response**: 
  - Status: 200 OK
  - Body: `{ "status": "healthy" }`

#### 2. List All Orders
- **Path**: `/v1/orders`
- **Method**: GET
- **Response**: 
  - Status: 200 OK
  - Body: Array of order objects
```json
{
  "orders": [
    {
      "order_id": number,
      "status": string,
      "total_amount": decimal,
      "items": Array<OrderItem>
    }
  ]
}
```

#### 3. Get Order by ID
- **Path**: `/v1/orders/:id`
- **Method**: GET
- **Response**: 
  - Status: 200 OK
  - Body: Single order object
  - Status: 404 Not Found (if order doesn't exist)

#### 4. Create New Order
- **Path**: `/v1/orders`
- **Method**: POST
- **Headers Required**: 
  - `Idempotency-Key`: Unique identifier for the request
- **Request Body**:
```json
{
  "items": [
    {
      "product_id": number,
      "quantity": number,
      "unit_price": decimal
    }
  ]
}
```
- **Response**:
  - Status: 201 Created
  - Status: 409 Conflict (if idempotency key already used)
  - Status: 400 Bad Request (if validation fails)

## 4. Interservice Communication

The Order Service communicates with other microservices through HTTP/REST APIs:

1. **Catalog Service**
   - Used for product information validation
   - Retrieves product details when creating orders
   - Endpoint: `{CATALOG_SERVICE_URL}/products/prices` - Verify product prices
   - Endpoint: `{CATALOG_SERVICE_URL}/products/{id}` - Get product details

2. **Inventory Service**
   - Checks product availability
   - Updates stock levels after order creation
   - Endpoint: `{INVENTORY_SERVICE_URL}/v1/inventory/reserve` - Reserve inventory
   - Endpoint: `{INVENTORY_SERVICE_URL}/v1/inventory/release` - Release inventory (compensation)

3. **Payment Service**
   - Processes payments for orders
   - Handles payment verification and transaction processing
   - Endpoint: `{PAYMENT_SERVICE_URL}/v1/payments`
   - Features:
     - Idempotency support via `Idempotency-Key` header
     - Payment method selection
     - Timeout handling (10 seconds)
   - Request Format:
     ```json
     {
       "orderId": "string",
       "amount": number,
       "method": "DEBIT CARD"
     }
     ```
   - Response Format:
     ```json
     {
       "status": "SUCCESS",
       "payment_id": "string"
     }
     ```
   - Error Handling:
     - Proper compensation in case of payment failure
     - Payment status tracking in order records

Communication is handled through the `apiClient.js` configuration, ensuring proper service discovery and error handling. All services use environment variables for service URLs and include proper error handling with compensation logic for failed transactions.

## 5. Database Schema

### Table: eci_orders
Primary table for order management
```sql
CREATE TABLE eci_orders (
  order_id INT NOT NULL AUTO_INCREMENT,
  status ENUM('PENDING', 'SHIPPED', 'CANCELLED') NOT NULL,
  total_amount DECIMAL(10,2) NOT NULL,
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  PRIMARY KEY (order_id)
);
```

### Table: eci_order_items
Stores individual items within each order
```sql
CREATE TABLE eci_order_items (
  order_item_id INT NOT NULL AUTO_INCREMENT,
  order_id INT,
  product_id INT,
  sku TEXT,
  quantity INT,
  unit_price DECIMAL(10,2) NOT NULL,
  line_status ENUM('PENDING','SHIPPED','CANCELLED') NOT NULL DEFAULT 'PENDING',
  product_name VARCHAR(255),
  tax_rate DECIMAL(5,4) NOT NULL DEFAULT '0.0500',
  PRIMARY KEY (order_item_id),
  FOREIGN KEY (order_id) REFERENCES eci_orders(order_id)
);
```

### Key Features of Schema
- Uses ENUM types for status management
- Implements proper decimal precision for monetary values
- Maintains referential integrity through foreign keys
- Includes audit fields (created_at, updated_at)
- Stores tax information at the line item level