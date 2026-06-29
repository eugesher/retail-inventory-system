// DI token for the bounded optimistic-concurrency retry budget (ADR-036). A
// `ConfigService`-backed value provider in `stock.module.ts` resolves it from
// `OCC_RETRY_ATTEMPTS` (Joi default 5), so every stock write use case injects a plain
// `number` and never reads env directly — the `RESERVATION_TTL_MINUTES` precedent. It is
// the per-attempt cap `runWithStockWriteRetry` honors: a lost compare-and-swap re-reads
// under a fresh transaction and retries up to this many times before surfacing a
// `409 STOCK_WRITE_CONFLICT`. A provider token, not a port, but it lives beside the ports
// so the use-case wiring is greppable in one place.
export const OCC_RETRY_ATTEMPTS = Symbol('OCC_RETRY_ATTEMPTS');
