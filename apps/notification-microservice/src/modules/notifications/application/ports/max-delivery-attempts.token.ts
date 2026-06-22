// DI token for the per-delivery retry cap (ADR-033). A `ConfigService`-backed value
// provider in `notifications.module.ts` resolves it from `MAX_DELIVERY_ATTEMPTS` (Joi
// default 3), so the retry use cases inject a plain `number` and never read env directly
// — the retail `RETURN_WINDOW_DAYS` / inventory `RESERVATION_TTL_MINUTES` precedent. It is
// a provider token, not a port, but lives next to the ports so the use-case wiring is
// greppable in one place.
//
// A delivery is retryable while `attemptCount < MAX_DELIVERY_ATTEMPTS`; once a (manual or
// scheduled) re-attempt pushes `attemptCount` to the cap and the row is still `failed`,
// the retry use case emits `notifications.delivery.failed` and the sweeper's
// `listRetryable` scan excludes it thereafter (so the failure event fires once).
export const MAX_DELIVERY_ATTEMPTS = Symbol('MAX_DELIVERY_ATTEMPTS');
