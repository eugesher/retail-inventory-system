import { Cache } from '@nestjs/cache-manager';
import KeyvRedis from '@keyv/redis';

import { RedisCacheAdapter } from '../redis-cache.adapter';

// Port-adapter contract test: the `RedisCacheAdapter` must honour the
// `ICachePort` semantics — `wrap` is read-through (calls fn on miss, skips
// fn on hit). Uses a hand-rolled cache stub so the test runs without Redis.
describe('RedisCacheAdapter', () => {
  const stubCache = (initial: Record<string, unknown> = {}): Cache => {
    const store = new Map(Object.entries(initial));
    return {
      get: jest.fn((key: string) => Promise.resolve(store.get(key))),
      set: jest.fn((key: string, value: unknown) => {
        store.set(key, value);
        return Promise.resolve();
      }),
      del: jest.fn((key: string) => {
        store.delete(key);
        return Promise.resolve();
      }),
    } as unknown as Cache;
  };

  const asyncIterableOf = (batches: string[][]): AsyncIterable<string[]> => ({
    [Symbol.asyncIterator]: async function* (): AsyncGenerator<string[]> {
      await Promise.resolve();
      for (const batch of batches) yield batch;
    },
  });

  const makeRedisStore = (overrides: {
    client: { scanIterator?: unknown; unlink?: unknown };
    namespace?: string;
    keyPrefixSeparator?: string;
  }): KeyvRedis<unknown> => {
    const stub = Object.create(KeyvRedis.prototype) as KeyvRedis<unknown>;
    Object.defineProperty(stub, 'client', {
      get: () => overrides.client,
      configurable: true,
    });
    Object.defineProperty(stub, 'namespace', {
      value: overrides.namespace ?? '',
      configurable: true,
      writable: true,
    });
    Object.defineProperty(stub, 'keyPrefixSeparator', {
      value: overrides.keyPrefixSeparator ?? '::',
      configurable: true,
      writable: true,
    });
    return stub;
  };

  const stubCacheWithStore = (store: unknown, initial: Record<string, unknown> = {}): Cache => {
    const base = stubCache(initial);
    (base as unknown as { stores: { store: unknown }[] }).stores = [{ store }];
    return base;
  };

  it('get returns undefined for missing keys', async () => {
    const adapter = new RedisCacheAdapter(stubCache());
    expect(await adapter.get('missing')).toBeUndefined();
  });

  it('set then get round-trips', async () => {
    const adapter = new RedisCacheAdapter(stubCache());
    await adapter.set('k', { a: 1 });
    expect(await adapter.get('k')).toEqual({ a: 1 });
  });

  it('wrap calls fn on miss and caches the result', async () => {
    const adapter = new RedisCacheAdapter(stubCache());
    const fn = jest.fn(() => Promise.resolve(42));

    expect(await adapter.wrap('k', 1000, fn)).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);

    expect(await adapter.wrap('k', 1000, fn)).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('del removes a key', async () => {
    const adapter = new RedisCacheAdapter(stubCache({ k: 'v' }));
    await adapter.del('k');
    expect(await adapter.get('k')).toBeUndefined();
  });

  describe('delByPrefix', () => {
    it('returns 0 when no Redis-backed store is present (in-memory fallback is a no-op)', async () => {
      const adapter = new RedisCacheAdapter(
        stubCacheWithStore({
          /* not KeyvRedis */
        }),
      );
      expect(await adapter.delByPrefix('ris:inventory:stock:1:')).toBe(0);
    });

    it('SCANs by prefix and UNLINKs every matched key', async () => {
      const scanIterator = jest.fn(() =>
        asyncIterableOf([['ris:inventory:stock:1:__all__', 'ris:inventory:stock:1:warehouse-a']]),
      );
      const unlink = jest.fn().mockResolvedValue(2);
      const store = makeRedisStore({ client: { scanIterator, unlink } });

      const adapter = new RedisCacheAdapter(stubCacheWithStore(store));

      const unlinked = await adapter.delByPrefix('ris:inventory:stock:1:');

      expect(scanIterator).toHaveBeenCalledWith({ MATCH: 'ris:inventory:stock:1:*', COUNT: 100 });
      expect(unlink).toHaveBeenCalledWith([
        'ris:inventory:stock:1:__all__',
        'ris:inventory:stock:1:warehouse-a',
      ]);
      expect(unlinked).toBe(2);
    });

    it('applies KeyvRedis namespace + separator to the SCAN pattern', async () => {
      const scanIterator = jest.fn(() => asyncIterableOf([[]]));
      const unlink = jest.fn();
      const store = makeRedisStore({
        client: { scanIterator, unlink },
        namespace: 'tenant-a',
        keyPrefixSeparator: '::',
      });

      const adapter = new RedisCacheAdapter(stubCacheWithStore(store));

      await adapter.delByPrefix('ris:inventory:stock:7:');

      expect(scanIterator).toHaveBeenCalledWith({
        MATCH: 'tenant-a::ris:inventory:stock:7:*',
        COUNT: 100,
      });
    });

    it('returns 0 and skips UNLINK when SCAN yields no keys', async () => {
      const scanIterator = jest.fn(() => asyncIterableOf([[]]));
      const unlink = jest.fn();
      const store = makeRedisStore({ client: { scanIterator, unlink } });

      const adapter = new RedisCacheAdapter(stubCacheWithStore(store));

      expect(await adapter.delByPrefix('ris:inventory:stock:1:')).toBe(0);
      expect(unlink).not.toHaveBeenCalled();
    });

    it('deduplicates keys returned across multiple SCAN cycles', async () => {
      const scanIterator = jest.fn(() =>
        asyncIterableOf([
          ['ris:inventory:stock:1:__all__'],
          ['ris:inventory:stock:1:warehouse-a', 'ris:inventory:stock:1:__all__'],
        ]),
      );
      const unlink = jest.fn().mockResolvedValue(2);
      const store = makeRedisStore({ client: { scanIterator, unlink } });

      const adapter = new RedisCacheAdapter(stubCacheWithStore(store));

      expect(await adapter.delByPrefix('ris:inventory:stock:1:')).toBe(2);
      expect(unlink).toHaveBeenCalledTimes(1);
      expect(unlink).toHaveBeenCalledWith([
        'ris:inventory:stock:1:__all__',
        'ris:inventory:stock:1:warehouse-a',
      ]);
    });

    it('returns 0 when the client lacks scanIterator (Cluster / Sentinel)', async () => {
      const store = makeRedisStore({ client: {} });
      const adapter = new RedisCacheAdapter(stubCacheWithStore(store));

      expect(await adapter.delByPrefix('ris:inventory:stock:1:')).toBe(0);
    });
  });
});
