import * as Joi from 'joi';

export const configModuleConfig = {
  isGlobal: true,
  envFilePath: ['.env.local', '.env'],
  validationSchema: Joi.object({
    NODE_ENV: Joi.string().valid('development', 'production', 'test').required(),

    API_GATEWAY_PORT: Joi.number().required().port(),
    API_GATEWAY_PREFIX: Joi.string().optional(),
    API_GATEWAY_USE_API_REFERENCE: Joi.boolean().default(process.env.NODE_ENV !== 'production'),

    DATABASE_URL: Joi.string().uri({ scheme: 'mysql' }).required(),
    DATABASE_LOGGING: Joi.boolean().default(process.env.NODE_ENV !== 'production'),

    // ISO-4217 currency the catalog publish precondition resolves against — a
    // product publishes only when every variant has an in-effect price in this
    // currency. Defaulted, so a missing var never fails boot.
    DEFAULT_CURRENCY: Joi.string().length(3).uppercase().default('USD'),

    LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace').optional(),

    RABBITMQ_URL: Joi.string().uri({ scheme: 'amqp' }).required(),

    REDIS_URL: Joi.string().uri({ scheme: 'redis' }).required(),

    CACHE_TTL_MS_DEFAULT: Joi.number().integer().positive().default(60000),
    CACHE_TTL_MS_PRODUCT_STOCK: Joi.number().integer().positive().default(60000),

    // Lifetime (minutes) of a stock reservation hold — `expiresAt = now +
    // RESERVATION_TTL_MINUTES` when a Reserve lands or refreshes (ADR-030 §4).
    // Defaulted, so a missing var never fails boot.
    RESERVATION_TTL_MINUTES: Joi.number().integer().positive().default(15),

    JWT_ACCESS_SECRET: Joi.string().min(32).required(),
    JWT_ACCESS_EXPIRES_IN: Joi.string().default('15m'),
    JWT_REFRESH_SECRET: Joi.string()
      .min(32)
      .required()
      .invalid(Joi.ref('JWT_ACCESS_SECRET'))
      .messages({
        'any.invalid': 'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET',
      }),
    JWT_REFRESH_EXPIRES_IN: Joi.string().default('7d'),
    AUTH_ARGON2_MEMORY_COST: Joi.number().integer().positive().default(19_456),
    AUTH_ARGON2_TIME_COST: Joi.number().integer().positive().default(2),
    AUTH_ARGON2_PARALLELISM: Joi.number().integer().positive().default(1),

    OTEL_SERVICE_NAME: Joi.string().required(),
    OTEL_EXPORTER_OTLP_ENDPOINT: Joi.string()
      .uri({ scheme: ['http', 'https'] })
      .required(),
    OTEL_RESOURCE_ATTRIBUTES: Joi.string().optional(),
    OTEL_SDK_DISABLED: Joi.boolean().default(false),
  }).options({ allowUnknown: true, abortEarly: false }),
};
