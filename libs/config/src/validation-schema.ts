import * as Joi from 'joi';

export const validationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production', 'test').default('development'),
  API_GATEWAY_PORT: Joi.number().default(3000).port(),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['mysql'] })
    .default('mysql://retail:retailpass@localhost:3306/retail_db'),
  REDIS_URL: Joi.string()
    .uri({ scheme: ['redis'] })
    .default('redis://redis:6379'),
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp'] })
    .default('amqp://guest:guest@localhost:5672'),
  API_PREFIX: Joi.string().default('api'),
}).options({ allowUnknown: true, abortEarly: false });
