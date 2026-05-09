import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';

import { ICachePort } from './cache.port';

// Adapter implementing `ICachePort` against the existing
// `@nestjs/cache-manager` + `@keyv/redis` setup. Preserves the ADR-002
// cache-aside contract for product-stock — the actual product-stock façade
// migration happens in task-08; task-04 only introduces this shape.
@Injectable()
export class RedisCacheAdapter implements ICachePort {
  constructor(
    @Inject(CACHE_MANAGER)
    private readonly cache: Cache,
  ) {}

  public async get<T>(key: string): Promise<T | undefined> {
    const value = await this.cache.get<T>(key);
    return value === null ? undefined : value;
  }

  public async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    await this.cache.set(key, value, ttlMs);
  }

  public async del(key: string): Promise<void> {
    await this.cache.del(key);
  }

  public async wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) {
      return cached;
    }
    const value = await fn();
    await this.set(key, value, ttlMs);
    return value;
  }
}
