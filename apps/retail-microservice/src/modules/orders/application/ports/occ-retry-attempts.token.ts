// DI token for the bounded optimistic-concurrency retry budget on the order write
// path (ADR-036). A `ConfigService`-backed value provider in `orders.module.ts`
// resolves it from `OCC_RETRY_ATTEMPTS` (Joi default 5), so every order-status
// mutator injects a plain `number` and never reads env directly — the
// `IDEMPOTENCY_KEY_TTL_HOURS` (orders) / `RESERVATION_TTL_MINUTES` (inventory) /
// `OCC_RETRY_ATTEMPTS` (cart) precedent. It is the per-attempt cap
// `runWithOrderWriteRetry` honors: a lost compare-and-swap on the order root
// version re-reads the row (a fresh transaction) and retries up to this many times
// before surfacing a `409 VERSION_MISMATCH`. A provider token, not a port, but it
// lives beside the ports so the use-case wiring is greppable in one place.
export const OCC_RETRY_ATTEMPTS = Symbol('OCC_RETRY_ATTEMPTS');
