// DI token for the bounded optimistic-concurrency retry budget on the return-request
// write path (ADR-036). A `ConfigService`-backed value provider in `returns.module.ts`
// resolves it from `OCC_RETRY_ATTEMPTS` (Joi default 5), so every return-status
// mutator injects a plain `number` and never reads env directly — the
// `RETURN_WINDOW_DAYS` (returns) / `OCC_RETRY_ATTEMPTS` (orders / cart / inventory)
// precedent. It is the per-attempt cap `runWithReturnWriteRetry` honors: a lost
// compare-and-swap on the return-request root version re-reads the row and retries up
// to this many times before surfacing a `409 VERSION_MISMATCH`. A provider token, not
// a port, but it lives beside the ports so the use-case wiring is greppable in one
// place. A distinct `Symbol` from the orders/cart tokens — module isolation (ADR-017).
export const OCC_RETRY_ATTEMPTS = Symbol('OCC_RETRY_ATTEMPTS');
