// The attempt cap every `runWith<X>WriteRetry` helper honours (ADR-036). A `ConfigService`-backed
// value provider in each module's `<m>.module.ts` resolves it from the `OCC_RETRY_ATTEMPTS` env
// var, so a use case injects a plain `number` and never reads `process.env` itself.
//
// A provider token, not a port — it is shared across modules rather than copied into each one's
// `application/ports/` (ADR-043).
//
// Sharing the symbol does not share the *value*: Nest providers are module-scoped, so each module
// binds its own provider and could bind a different budget.
export const OCC_RETRY_ATTEMPTS = Symbol('OCC_RETRY_ATTEMPTS');
