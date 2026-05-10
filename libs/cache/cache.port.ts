// Cache abstraction. Domain code depends on this port; only adapters in this
// lib (and integration tests) reach for the concrete `Cache` from
// `@nestjs/cache-manager`. The contract is intentionally narrow: get/set/del
// for direct manipulation, plus `wrap` for the read-through cache-aside
// pattern formalized in ADR-002 / ADR-006.
export const CACHE_PORT = Symbol('CachePort');

export interface ICachePort {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T>;
}
