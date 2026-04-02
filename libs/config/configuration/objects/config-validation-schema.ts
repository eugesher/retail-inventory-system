import * as Joi from 'joi';

export const configValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').required(),

  API_GATEWAY_PORT: Joi.number().required().port(),
  API_GATEWAY_PREFIX: Joi.string().optional(),

  DATABASE_URL: Joi.string().uri({ scheme: 'mysql' }).required(),
  DATABASE_LOGGING: Joi.boolean().optional(),

  // REVIEW-FIX: CONF-007 — validate LOG_LEVEL used by logger.config.ts
  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace').optional(),

  RABBITMQ_URL: Joi.string().uri({ scheme: 'amqp' }).required(),

  REDIS_URL: Joi.string().uri({ scheme: 'redis' }).required(),
}).options({ allowUnknown: true, abortEarly: false });
