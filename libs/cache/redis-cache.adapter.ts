import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';
import KeyvRedis from '@keyv/redis';
import { trace } from '@opentelemetry/api';

import { ICachePort } from './cache.port';

const TRACER_NAME = '@retail-inventory-system/cache';

// Narrow structural type for the subset of the @redis/client v5 client we
// actually need. KeyvRedis exposes the client as a wide union
// (RedisClientType | RedisClusterType | RedisSentinelType) with empty
// module/function/script generics, which doesn't structurally match the
// generic signatures of scanIterator/unlink. Declaring just what we use
// sidesteps the generic mismatch without resorting to `any`.
interface IRedisScanClient {
  scanIterator(options: { MATCH: string; COUNT?: number }): AsyncIterable<string[]>;
  unlink(keys: string[]): Promise<number>;
}

// Adapter implementing `ICachePort` against the existing
// `@nestjs/cache-manager` + `@keyv/redis` setup. Preserves the ADR-002
// cache-aside contract for product-stock and adds the generalized
// invalidation primitive (`delByPrefix`) used by every aggregate cache
// in task-11 / ADR-016.
@Injectable()
export class RedisCacheAdapter implements ICachePort {
  constructor(
    @Inject(CACHE_MANAGER)
    private readonly cache: Cache,
  ) {}

  public async get<T>(key: string): Promise<T | undefined> {
    const tracer = trace.getTracer(TRACER_NAME);
    return tracer.startActiveSpan('cache.get', async (span) => {
      span.setAttribute('cache.key', key);
      try {
        const value = await this.cache.get<T>(key);
        const hit = value !== null && value !== undefined;
        span.setAttribute('cache.hit', hit);
        return hit ? (value as T) : undefined;
      } finally {
        span.end();
      }
    });
  }

  public async set<T>(key: string, value: T, ttlMs?: number): Promise<void> {
    const tracer = trace.getTracer(TRACER_NAME);
    return tracer.startActiveSpan('cache.set', async (span) => {
      span.setAttribute('cache.key', key);
      if (ttlMs !== undefined) {
        span.setAttribute('cache.ttl_ms', ttlMs);
      }
      try {
        await this.cache.set(key, value, ttlMs);
      } finally {
        span.end();
      }
    });
  }

  public async del(key: string): Promise<void> {
    const tracer = trace.getTracer(TRACER_NAME);
    return tracer.startActiveSpan('cache.del', async (span) => {
      span.setAttribute('cache.key', key);
      try {
        await this.cache.del(key);
      } finally {
        span.end();
      }
    });
  }

  public async wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const tracer = trace.getTracer(TRACER_NAME);
    return tracer.startActiveSpan('cache.wrap', async (span) => {
      span.setAttribute('cache.key', key);
      try {
        const cached = await this.get<T>(key);
        if (cached !== undefined) {
          span.setAttribute('cache.hit', true);
          return cached;
        }
        span.setAttribute('cache.hit', false);
        const value = await fn();
        await this.set(key, value, ttlMs);
        return value;
      } finally {
        span.end();
      }
    });
  }

  public async delByPrefix(prefix: string): Promise<number> {
    const tracer = trace.getTracer(TRACER_NAME);
    return tracer.startActiveSpan('cache.delByPrefix', async (span) => {
      span.setAttribute('cache.prefix', prefix);
      try {
        const adapter = this.getRedisAdapter();
        if (!adapter) {
          span.setAttribute('cache.backend', 'non-redis');
          span.setAttribute('cache.keys_unlinked', 0);
          return 0;
        }

        const rawClient = adapter.client;
        if (!('scanIterator' in rawClient) || !('unlink' in rawClient)) {
          // Cluster / Sentinel clients don't expose scanIterator on the
          // top-level client (you'd have to fan out per shard). The project
          // uses a single Redis instance, so this branch should never hit
          // in practice — but we treat it as a no-op rather than a throw.
          span.setAttribute('cache.backend', 'redis-no-scan');
          span.setAttribute('cache.keys_unlinked', 0);
          return 0;
        }

        const client = rawClient as unknown as IRedisScanClient;
        // KeyvRedis prefixes stored keys with `${namespace}${keyPrefixSeparator}`
        // when a namespace is configured. With no namespace (the project
        // default — see libs/cache/cache-module.config.ts) the prefix is empty
        // and stored keys match cache.set() input verbatim. Computing the
        // prefix at runtime keeps this code correct if a namespace is added
        // later.
        const keyPrefix = adapter.namespace
          ? `${adapter.namespace}${adapter.keyPrefixSeparator}`
          : '';
        const pattern = `${keyPrefix}${prefix}*`;

        const matchedKeys = new Set<string>();
        for await (const batch of client.scanIterator({ MATCH: pattern, COUNT: 100 })) {
          for (const key of batch) matchedKeys.add(key);
        }

        if (matchedKeys.size === 0) {
          span.setAttribute('cache.backend', 'redis');
          span.setAttribute('cache.keys_unlinked', 0);
          return 0;
        }

        // UNLINK frees memory asynchronously on the Redis side — preferred
        // over DEL when invalidating potentially-large key sets, since DEL
        // is O(N) synchronous from Redis's main thread.
        await client.unlink([...matchedKeys]);
        span.setAttribute('cache.backend', 'redis');
        span.setAttribute('cache.keys_unlinked', matchedKeys.size);
        return matchedKeys.size;
      } finally {
        span.end();
      }
    });
  }

  private getRedisAdapter(): KeyvRedis<unknown> | undefined {
    // `cache-manager.createCache()` returns an object whose `stores` array
    // holds Keyv instances. Each Keyv exposes its underlying adapter via
    // the `store` getter — for our config that adapter is `KeyvRedis`.
    const cache = this.cache as unknown as {
      stores?: readonly { store?: unknown }[];
    };
    const stores = cache.stores;
    if (!stores || stores.length === 0) return undefined;
    const underlying = stores[0]?.store;
    return underlying instanceof KeyvRedis ? (underlying as KeyvRedis<unknown>) : undefined;
  }
}
