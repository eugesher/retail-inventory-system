// DI token for the reservation hold lifetime in minutes (ADR-030 §4). A
// `ConfigService`-backed value provider in `stock.module.ts` resolves it from
// `RESERVATION_TTL_MINUTES` (Joi default 15), so the Reserve use case injects a
// plain `number` and never reads env directly — the catalog
// `CATALOG_DEFAULT_CURRENCY ← DEFAULT_CURRENCY` precedent. It is a provider token,
// not a port, but lives next to the ports so the use-case wiring is greppable in
// one place.
export const RESERVATION_TTL_MINUTES = Symbol('RESERVATION_TTL_MINUTES');
