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

    // The event-store microservice persists the event firehose + the staff audit log to
    // an isolated logical database `ris_eventstore` (same MySQL instance, separate
    // schema + migration history), kept off the operational `retail_db` so the
    // write-heavy append stream never pressures live checkout/inventory reads
    // (ADR-034). Required — the event store fails fast at boot without it; the other
    // five services never read it.
    EVENTSTORE_DATABASE_URL: Joi.string().uri({ scheme: 'mysql' }).required(),

    // ISO-4217 currency the catalog publish precondition resolves against — a
    // product publishes only when every variant has an in-effect price in this
    // currency. Defaulted, so a missing var never fails boot.
    DEFAULT_CURRENCY: Joi.string().length(3).uppercase().default('USD'),

    LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace').optional(),

    RABBITMQ_URL: Joi.string().uri({ scheme: 'amqp' }).required(),

    // Per-service timeout for the `GET /api/health` liveness fan-out (ADR-044). Bounds ONE
    // probe, not the fan-out — the five run concurrently.
    HEALTH_PROBE_TIMEOUT_MS: Joi.number().integer().min(100).default(2000),

    REDIS_URL: Joi.string().uri({ scheme: 'redis' }).required(),

    CACHE_TTL_MS_DEFAULT: Joi.number().integer().positive().default(60000),
    CACHE_TTL_MS_PRODUCT_STOCK: Joi.number().integer().positive().default(60000),

    // Lifetime (minutes) of a stock reservation hold — `expiresAt = now +
    // RESERVATION_TTL_MINUTES` when a Reserve lands or refreshes (ADR-030 §4).
    // Defaulted, so a missing var never fails boot.
    RESERVATION_TTL_MINUTES: Joi.number().integer().positive().default(15),

    // Upper bound on the rows a single expired-reservation sweep invocation scans and
    // expires — it caps the work per tick, so a backlog drains across successive sweeps
    // (ADR-038). Defaulted, so a missing var never fails boot (the
    // `RESERVATION_TTL_MINUTES` precedent).
    RESERVATION_SWEEP_BATCH_SIZE: Joi.number().integer().min(1).default(200),

    // How many reservations one sweep transaction expires. It bounds how long the sweep
    // holds row locks, keeping the concurrent checkout writes it races with responsive
    // (ADR-038). Defaulted, so a missing var never fails boot.
    RESERVATION_SWEEP_TRANSACTION_SIZE: Joi.number().integer().min(1).default(25),

    // Seconds between expired-reservation sweep invocations (ADR-038). It decides only how
    // promptly an ALREADY-expired hold is reclaimed — `RESERVATION_TTL_MINUTES` is what
    // bounds a hold's life — so it should tick well inside the TTL. Defaulted, so a missing
    // var never fails boot (the `RESERVATION_TTL_MINUTES` precedent).
    RESERVATION_SWEEP_INTERVAL_SECONDS: Joi.number().integer().min(1).default(60),

    // Return-eligibility window (days) — a `shipped` order is returnable only within
    // `RETURN_WINDOW_DAYS` of its ship date; a `delivered` order is always returnable
    // (ADR-032). The Open return use case reads it. Defaulted, so a missing var never
    // fails boot (the `RESERVATION_TTL_MINUTES` precedent).
    RETURN_WINDOW_DAYS: Joi.number().integer().positive().default(30),

    // Idempotency-key retention (hours) — a stored idempotency record becomes eligible
    // for the purge sweep once `created_at + IDEMPOTENCY_KEY_TTL_HOURS` has passed
    // (ADR-036). The retail idempotency store + its scheduled sweeper read it. Defaulted,
    // so a missing var never fails boot (the `RESERVATION_TTL_MINUTES` precedent).
    IDEMPOTENCY_KEY_TTL_HOURS: Joi.number().integer().min(1).default(24),

    // Bounded retry budget for optimistic-concurrency (version-checked) writes. On a lost
    // compare-and-swap the write re-reads under a fresh transaction and retries up to this
    // many attempts before surfacing a 409 (`STOCK_WRITE_CONFLICT` inventory-side, the
    // forthcoming `VERSION_MISMATCH` for Cart/Order/Fulfillment/ReturnRequest) — ADR-036.
    // Default 5 keeps high-contention writes converging. Defaulted, so a missing var never
    // fails boot (the `RESERVATION_TTL_MINUTES` precedent).
    OCC_RETRY_ATTEMPTS: Joi.number().integer().min(1).default(5),

    // Ops mailbox for system-only notifications with no customer recipient
    // (e.g. the inventory low-stock alert). Defaulted so a missing var never fails boot.
    OPS_NOTIFICATIONS_EMAIL: Joi.string().email().default('ops@example.com'),
    // Max attempts before a notification delivery is abandoned and
    // `notifications.delivery.failed` is emitted.
    MAX_DELIVERY_ATTEMPTS: Joi.number().integer().positive().default(3),
    // **DEAD KEY — nothing reads this.** It is validated and defaulted here, so it passes boot in
    // every service, but no DI token, use case or scheduler consumes it and no delivery-retention
    // purge exists. `notification_delivery` grows without bound; setting this changes nothing.
    // Either wire a purge (the `IdempotencyPurgeScheduler` shape) or delete the key.
    RETENTION_DELIVERY_DAYS: Joi.number().integer().positive().default(90),
    // TTL (seconds) for a cached notification consent snapshot (ADR-037). The consent
    // cache is kept fresh by the customer.consent.updated / customer.erased consumer, so
    // this TTL is only a staleness safety net if an event is missed. Defaulted, so a
    // missing var never fails boot (the `RETENTION_DELIVERY_DAYS` precedent).
    NOTIFICATIONS_CONSENT_CACHE_TTL_SECONDS: Joi.number().integer().positive().default(300),
    // TEST-ONLY: when true, the notification microservice binds a deterministically-flaky
    // NOTIFIER that fails a delivery carrying the test marker once (to exercise the retry
    // path). Defaults false; production must never enable it.
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
