// DI token for the idempotency-key retention horizon in hours (ADR-036). A
// `ConfigService`-backed value provider in `orders.module.ts` resolves it from
// `IDEMPOTENCY_KEY_TTL_HOURS` (Joi default 24), so the store adapter injects a plain
// `number` and never reads env directly — the inventory `RESERVATION_TTL_MINUTES` /
// `OCC_RETRY_ATTEMPTS` precedent (ADR-017: configuration reaches the application layer
// only through DI). It is a provider token, not a port, but lives next to the ports so
// the wiring is greppable in one place.
export const IDEMPOTENCY_KEY_TTL_HOURS = Symbol('IDEMPOTENCY_KEY_TTL_HOURS');
