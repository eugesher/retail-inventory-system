export const CACHE_PORT = Symbol('CachePort');

export interface ICachePort {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
  del(key: string): Promise<void>;
  delByPrefix(prefix: string): Promise<number>;
  wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T>;
  singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T>;
}
