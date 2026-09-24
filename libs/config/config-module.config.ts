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

    EVENTSTORE_DATABASE_URL: Joi.string().uri({ scheme: 'mysql' }).required(),

    DEFAULT_CURRENCY: Joi.string().length(3).uppercase().default('USD'),

    LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace').optional(),

    RABBITMQ_URL: Joi.string().uri({ scheme: 'amqp' }).required(),

    HEALTH_PROBE_TIMEOUT_MS: Joi.number().integer().min(100).default(2000),

    REDIS_URL: Joi.string().uri({ scheme: 'redis' }).required(),

    CACHE_TTL_MS_DEFAULT: Joi.number().integer().positive().default(60000),
    CACHE_TTL_MS_PRODUCT_STOCK: Joi.number().integer().positive().default(60000),

    RESERVATION_TTL_MINUTES: Joi.number().integer().positive().default(15),

    RESERVATION_SWEEP_BATCH_SIZE: Joi.number().integer().min(1).default(200),

    RESERVATION_SWEEP_TRANSACTION_SIZE: Joi.number().integer().min(1).default(25),

    RESERVATION_SWEEP_INTERVAL_SECONDS: Joi.number().integer().min(1).default(60),

    RETURN_WINDOW_DAYS: Joi.number().integer().positive().default(30),

    IDEMPOTENCY_KEY_TTL_HOURS: Joi.number().integer().min(1).default(24),

    OCC_RETRY_ATTEMPTS: Joi.number().integer().min(1).default(5),

    CAPTURE_CLAIM_STALE_MINUTES: Joi.number().integer().positive().default(15),

    OPS_NOTIFICATIONS_EMAIL: Joi.string().email().default('ops@example.com'),
    MAX_DELIVERY_ATTEMPTS: Joi.number().integer().positive().default(3),
    RETENTION_DELIVERY_DAYS: Joi.number().integer().positive().default(90),
    NOTIFICATIONS_CONSENT_CACHE_TTL_SECONDS: Joi.number().integer().positive().default(300),
    NOTIFIER_TEST_FLAKY: Joi.boolean().default(false),

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
