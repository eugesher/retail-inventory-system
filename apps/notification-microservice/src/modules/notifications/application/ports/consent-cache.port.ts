import { IConsentSnapshot } from './consent-reader.port';

export const CONSENT_CACHE = Symbol('CONSENT_CACHE');

// TTL (seconds) for a cached consent snapshot, threaded from
// `NOTIFICATIONS_CONSENT_CACHE_TTL_SECONDS` (Joi default 300) via a value-provider
// token so the cache adapter injects a plain number rather than reading `process.env`
// in the application layer (the `RESERVATION_TTL_MINUTES` / `MAX_DELIVERY_ATTEMPTS`
// precedent). The TTL is a **safety net** (ADR-002): the cache is kept fresh by the
// `customer.consent.updated` write-through / `customer.erased` eviction consumer, so
// the TTL only bounds staleness if an event is missed.
export const CONSENT_CACHE_TTL_SECONDS = Symbol('CONSENT_CACHE_TTL_SECONDS');

// The consent-gate's read seam — a domain-shaped cache over the generic `ICachePort`
// (the `IStockCachePort` precedent, ADR-006/023): the Render & Dispatch use case
// depends on this port and never sees a cache-key string or the raw SQL reader.
//
// - `get` is cache-aside: a hit returns the cached snapshot; a miss single-flights the
//   `CONSENT_READER` load, writes the result back under the TTL, and returns it —
//   resolving an absent row to `DEFAULT_CONSENT`. It is **fail-safe by contract**: it
//   never throws (a Redis / DB hiccup warn-logs and falls back to the reader, then to
//   the defaults) so it can be called from an `@EventPattern` dispatch without ever
//   blind-redelivering (ADR-011 §7).
// - `set` is the write-through the `customer.consent.updated` consumer calls to refresh
//   the entry from the event snapshot (no DB read).
// - `del` is the eviction the `customer.erased` consumer calls — a subsequent dispatch
//   re-loads defaults (marketing denied), so an erased customer's marketing sends stop.
export interface IConsentCachePort {
  get(customerId: string): Promise<IConsentSnapshot>;
  set(customerId: string, consent: IConsentSnapshot): Promise<void>;
  del(customerId: string): Promise<void>;
}
