version: '3.8'

services:
  # ------------------------------------
  # 1. MySQL Database Service
  # ------------------------------------
  order-db:
    image: mysql:8.0
    container_name: order-db
    environment:
      # Password must match the one in your .env
      MYSQL_ROOT_PASSWORD: chima1234
      MYSQL_DATABASE: order_db             
    volumes:
      - order_db_data:/var/lib/mysql
    ports:
      # Host Port 3307 -> Container Port 3306 (This is correct)
      - "3307:3306"
    healthcheck:
      # CRITICAL FIX 1: Update healthcheck password to match the one set above
      test: ["CMD", "mysqladmin" ,"ping", "-h", "localhost", "-u", "root", "-pchima1234"]
      interval: 10s
      timeout: 5s
      retries: 5

  # ------------------------------------
  # 2. Node.js Order Service
  # ------------------------------------
  order-service:
    build:
      context: .
      dockerfile: Dockerfile
      # CRITICAL FIX 2: Pass DATABASE_URL with service name 'order-db' for Prisma generate
      args:
        - DATABASE_URL=mysql://root:chima1234@order-db:3306/order_db
    container_name: order-service
    ports:
      - "8080:8080"
    environment:
      # CRITICAL FIX 3: Application connection MUST use service name 'order-db'
      DATABASE_URL: mysql://root:chima1234@order-db:3306/order_db
      # Load other environment variables
      CATALOG_SERVICE_URL: ${CATALOG_SERVICE_URL}
      INVENTORY_SERVICE_URL: ${INVENTORY_SERVICE_URL}
      PAYMENT_SERVICE_URL: ${PAYMENT_SERVICE_URL}
    depends_on:
      order-db:
        condition: service_healthy

volumes:
  order_db_data:
