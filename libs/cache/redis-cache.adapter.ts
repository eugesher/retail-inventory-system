import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable, OnApplicationShutdown } from '@nestjs/common';
import KeyvRedis from '@keyv/redis';
import { trace } from '@opentelemetry/api';

import { ICachePort } from './cache.port';

const TRACER_NAME = '@retail-inventory-system/cache';

interface IRedisScanClient {
  scanIterator(options: { MATCH: string; COUNT?: number }): AsyncIterable<string[]>;
  unlink(keys: string[]): Promise<number>;
}

@Injectable()
export class RedisCacheAdapter implements ICachePort, OnApplicationShutdown {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    @Inject(CACHE_MANAGER)
    private readonly cache: Cache,
  ) {}

  public async onApplicationShutdown(): Promise<void> {
    await this.getRedisAdapter()?.disconnect();
  }

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

  public singleFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const tracer = trace.getTracer(TRACER_NAME);
    return tracer.startActiveSpan('cache.singleFlight', (span) => {
      span.setAttribute('cache.key', key);
      const existing = this.inFlight.get(key) as Promise<T> | undefined;
      if (existing) {
        span.setAttribute('cache.singleflight.joined', true);
        span.end();
        return existing;
      }
      span.setAttribute('cache.singleflight.joined', false);
      const promise = (async (): Promise<T> => fn())().finally(() => {
        this.inFlight.delete(key);
      });
      this.inFlight.set(key, promise);
      span.end();
      return promise;
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
          span.setAttribute('cache.backend', 'redis-no-scan');
          span.setAttribute('cache.keys_unlinked', 0);
          return 0;
        }

        const client = rawClient as unknown as IRedisScanClient;
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
    const cache = this.cache as unknown as {
      stores?: readonly { store?: unknown }[];
    };
    const stores = cache.stores;
    if (!stores || stores.length === 0) return undefined;
    const underlying = stores[0]?.store;
    return underlying instanceof KeyvRedis ? (underlying as KeyvRedis<unknown>) : undefined;
  }
}
