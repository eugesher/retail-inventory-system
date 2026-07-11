// DI token for the bounded optimistic-concurrency retry budget (ADR-036). A
// `ConfigService`-backed value provider in each module's `<m>.module.ts` resolves it from the
// `OCC_RETRY_ATTEMPTS` env var (Joi default 5), so a use case injects a plain `number` and
// never reads `process.env` itself.
//
// It is the attempt cap every `runWith<X>WriteRetry` helper honours: a lost compare-and-swap
// re-reads the aggregate under a fresh transaction and retries up to this many times before
// surfacing a `409 VERSION_MISMATCH` (or the module's own conflict code).
//
// A provider token, not a port. It lives here rather than in each module's
// `application/ports/` because four modules need the identical symbol — inventory `stock`,
// retail `cart` / `orders` / `returns` — and cross-module isolation makes a module-local copy
// the only alternative (ADR-043; each carried a byte-identical one before). It sits beside
// `idempotency/`, the other half of ADR-036.
//
// Sharing the symbol does not share the *value*: Nest providers are module-scoped, so each
// module still binds its own provider and could bind a different budget.
export const OCC_RETRY_ATTEMPTS = Symbol('OCC_RETRY_ATTEMPTS');
