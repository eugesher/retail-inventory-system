import * as Joi from 'joi';

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').required(),

  API_GATEWAY_PORT: Joi.number().required().port(),
  API_GATEWAY_PREFIX: Joi.string().required(),

  DATABASE_URL: Joi.string().uri({ scheme: 'mysql' }).required(),
  DATABASE_LOGGING: Joi.boolean().required(),

  RABBITMQ_URL: Joi.string().uri({ scheme: 'amqp' }).required(),

  REDIS_URL: Joi.string().uri({ scheme: 'redis' }).required(),
}).options({ allowUnknown: true, abortEarly: false });
