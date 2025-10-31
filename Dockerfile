# Stage 1: Build Stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package.json and package-lock.json first to cache dependencies layer
COPY package*.json ./
RUN npm install

# Copy application source code
COPY . .

# Generate the Prisma client inside the container
# We need the DATABASE_URL to be available for 'prisma generate'
ARG DATABASE_URL
ENV DATABASE_URL=${DATABASE_URL}
RUN npx prisma generate --schema ./prisma/schema.prisma

# Stage 2: Production Stage
FROM node:20-alpine

WORKDIR /app

# Copy only necessary files from the builder stage
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/src ./src
COPY --from=builder /app/package.json .
# Copy the generated Prisma client folder
COPY --from=builder /app/node_modules/@prisma/client ./node_modules/@prisma/client
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/.env ./.env

# The service runs on port 8080
EXPOSE 8080

# Command to run the application
CMD ["npm", "start"]
