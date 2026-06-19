// DI token for the return-eligibility window in days (ADR-032). A `ConfigService`-backed
// value provider in `returns.module.ts` resolves it from `RETURN_WINDOW_DAYS` (Joi
// default 30), so the Open use case injects a plain `number` and never reads env directly
// — the inventory `RESERVATION_TTL_MINUTES` / catalog `CATALOG_DEFAULT_CURRENCY`
// precedent. It is a provider token, not a port, but lives next to the ports so the
// use-case wiring is greppable in one place.
export const RETURN_WINDOW_DAYS = Symbol('RETURN_WINDOW_DAYS');
