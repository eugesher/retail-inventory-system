// Set all required env vars before any NestJS module is imported.
// These values point to the local docker compose infrastructure.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'mysql://retail:retailpass@localhost:3306/retail_db';
process.env.DATABASE_LOGGING = 'false';
process.env.RABBITMQ_URL = 'amqp://guest:guest@localhost:5672';
process.env.REDIS_URL = 'redis://localhost:6379';
process.env.API_GATEWAY_PORT = '3000';
process.env.API_GATEWAY_PREFIX = 'api';
