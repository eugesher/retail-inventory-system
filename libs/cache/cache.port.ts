// Cache abstraction. Domain code depends on this port; only adapters in this
// lib (and integration tests) reach for the concrete `Cache` from
// `@nestjs/cache-manager`.
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
  // In-process single-flight: concurrent calls with the same `key` share
  // one invocation of `fn`. Followers await the leader's promise and
  // observe the same outcome (value or rejection). The in-flight entry is
  // cleared in `finally` so a rejected leader does not poison the key.
  // Scope is the current Node process — see ADR-021 for the choice to
  // skip a store-side advisory lock.
  singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T>;
}
