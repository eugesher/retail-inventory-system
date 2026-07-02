// DI token for the bounded optimistic-concurrency retry budget on the cart write
// path (ADR-036). A `ConfigService`-backed value provider in `cart.module.ts`
// resolves it from `OCC_RETRY_ATTEMPTS` (Joi default 5), so every cart mutator
// injects a plain `number` and never reads env directly — the
// `IDEMPOTENCY_KEY_TTL_HOURS` (orders) / `RESERVATION_TTL_MINUTES` (inventory)
// precedent. It is the per-attempt cap `runWithCartWriteRetry` honors: a lost
// compare-and-swap on the cart root version re-reads the row and retries up to
// this many times before surfacing a `409 VERSION_MISMATCH`. When the client
// pinned an `If-Match` version the budget collapses to a single attempt (a lost
// race is reported immediately, not retried). A provider token, not a port, but
// it lives beside the ports so the use-case wiring is greppable in one place.
export const OCC_RETRY_ATTEMPTS = Symbol('OCC_RETRY_ATTEMPTS');
