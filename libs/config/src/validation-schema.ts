import * as Joi from 'joi';

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),

  PORT: Joi.number().default(3000).port(),

  DATABASE_URL: Joi.string()
    .uri({ scheme: ['mysql'] })
    .default('mysql://retail:retailpass@mysql:3306/retail_db'),

  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis'] })
    .default('redis://redis:6379'),

  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp'] })
    .default('amqp://guest:guest@rabbitmq:5672'),

  JWT_SECRET: Joi.string().min(16).default('local-dev-secret-very-insecure-do-not-use-in-prod'),

  JWT_EXPIRES_IN: Joi.string().default('1d'),

  GATEWAY_PORT: Joi.number().default(3000).port(),
  API_PREFIX: Joi.string().default('api/v1'),
  ENABLE_GRAPHQL: Joi.boolean().default(true),
  ENABLE_SWAGGER: Joi.boolean().default(true),

  LOW_STOCK_THRESHOLD: Joi.number().integer().min(1).default(10),
  CACHE_TTL_SECONDS: Joi.number().integer().min(60).default(300),

  MAX_ORDER_ITEMS: Joi.number().integer().min(1).default(50),

  EMAIL_PROVIDER: Joi.string().valid('console', 'sendgrid', 'resend').default('console'),
  EMAIL_API_KEY: Joi.string().optional(),

  SENTRY_DSN: Joi.string().uri().optional().default(''),

  THROTTLE_TTL: Joi.number().default(60),
  THROTTLE_LIMIT: Joi.number().default(100),
}).options({ allowUnknown: true, abortEarly: false });
