// DI token for how old a `capturing` payment must be before it is reported as stranded (ADR-052). A
// `ConfigService`-backed value provider in `orders.module.ts` resolves it from
// `CAPTURE_CLAIM_STALE_MINUTES` (Joi default 15), so the use case injects a plain `number` and never
// reads env — the `RESERVATION_TTL_MINUTES` / `RETAIL_DEFAULT_CURRENCY` precedent.
//
// **It is a reporting horizon, not a TTL.** Nothing expires when it elapses and nothing is released:
// a claim past this age is simply *old enough that a human should look*. A capture that is genuinely
// in flight resolves in a gateway round-trip, so anything still `capturing` minutes later is almost
// certainly a crashed request — and "almost certainly" is exactly why the system will not act on it
// by itself.
export const CAPTURE_CLAIM_STALE_MINUTES = Symbol('CAPTURE_CLAIM_STALE_MINUTES');
