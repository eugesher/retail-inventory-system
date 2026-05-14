// Cache abstraction. Domain code depends on this port; only adapters in this
// lib (and integration tests) reach for the concrete `Cache` from
// `@nestjs/cache-manager`. The contract is intentionally narrow: get/set/del
// for direct manipulation, `wrap` for the read-through cache-aside pattern
// formalized in ADR-002 / ADR-006 / ADR-016, plus `delByPrefix` for the
// multi-key invalidation that the stock cache needs.
export const CACHE_PORT = Symbol('CachePort');

export interface ICachePort {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  // Best-effort prefix invalidation. On Redis-backed stores this issues
  // SCAN MATCH `${prefix}*` followed by UNLINK; on backends that lack
  // iteration support (e.g. an in-memory adapter under unit tests) the
  // returned value is 0 and existing entries expire on TTL. Returns the
  // number of keys actually unlinked so callers can debug-log it.
  delByPrefix(prefix: string): Promise<number>;
  wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T>;
}
