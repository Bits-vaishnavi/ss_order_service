### Step 2: Database Setup

#### 2.1 Order Service Database

Start the database container:

```bash
cd ss_order_service-master
docker-compose up -d
```

Wait for the database to be ready (about 30 seconds), then load the SQL dump:

```bash
# Option 1: Using Docker exec
docker exec -i order-db mysql -uroot -pchima1234 order_db < Dump20251102.sql


## 📡 API Endpoints

### Order Service

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Health check |
| `GET` | `/v1/orders` | List all orders |
| `GET` | `/v1/orders/:id` | Get order by ID |
| `POST` | `/v1/orders` | Create new order (requires `Idempotency-Key` header) |
