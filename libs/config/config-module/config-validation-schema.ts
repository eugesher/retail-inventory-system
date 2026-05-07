import * as Joi from 'joi';

export const configValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').required(),

  API_GATEWAY_PORT: Joi.number().required().port(),
  API_GATEWAY_PREFIX: Joi.string().optional(),
  API_GATEWAY_USE_API_REFERENCE: Joi.boolean().default(process.env.NODE_ENV !== 'production'),

  DATABASE_URL: Joi.string().uri({ scheme: 'mysql' }).required(),
  DATABASE_LOGGING: Joi.boolean().default(process.env.NODE_ENV !== 'production'),

  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace').optional(),

  RABBITMQ_URL: Joi.string().uri({ scheme: 'amqp' }).required(),

  REDIS_URL: Joi.string().uri({ scheme: 'redis' }).required(),

  CACHE_TTL_MS_DEFAULT: Joi.number().integer().positive().default(60000),
  CACHE_TTL_MS_PRODUCT_STOCK: Joi.number().integer().positive().default(60000),
}).options({ allowUnknown: true, abortEarly: false });
