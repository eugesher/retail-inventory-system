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

  describe('singleFlight', () => {
    // ADR-021: concurrent calls with the same key share one invocation of
    // `fn`; followers observe the leader's outcome (value or rejection);
    // the in-flight slot is cleared in `finally` so a rejection does not
    // poison the key. These tests pin those guarantees.

    it('invokes fn exactly once when N callers hit the same key concurrently', async () => {
      const adapter = new RedisCacheAdapter(stubCache());
      let resolveLeader!: (value: number) => void;
      const fn = jest.fn(
        () =>
          new Promise<number>((resolve) => {
            resolveLeader = resolve;
          }),
      );

      const callers = Array.from({ length: 20 }, () => adapter.singleFlight('k', fn));
      // Let the leader start before resolving — otherwise the loader could
      // resolve in the same microtask and clear the in-flight slot before
      // the rest of the callers attach.
      await Promise.resolve();
      resolveLeader(7);

      const results = await Promise.all(callers);

      expect(fn).toHaveBeenCalledTimes(1);
      expect(results).toEqual(Array(20).fill(7));
    });

    it('propagates the same rejection to every waiter', async () => {
      const adapter = new RedisCacheAdapter(stubCache());
      const err = new Error('leader-fail');
      let rejectLeader!: (e: Error) => void;
      const fn = jest.fn(
        () =>
          new Promise<number>((_, reject) => {
            rejectLeader = reject;
          }),
      );

      const callers = Array.from({ length: 5 }, () => adapter.singleFlight('k', fn));
      await Promise.resolve();
      rejectLeader(err);

      const results = await Promise.allSettled(callers);
      expect(fn).toHaveBeenCalledTimes(1);
      for (const r of results) {
        expect(r.status).toBe('rejected');
        if (r.status === 'rejected') expect(r.reason).toBe(err);
      }
    });

    it('clears the in-flight slot after a successful resolution', async () => {
      const adapter = new RedisCacheAdapter(stubCache());
      const fn = jest.fn(() => Promise.resolve(1));

      await adapter.singleFlight('k', fn);
      await adapter.singleFlight('k', fn);

      // A fresh call after the first settles must invoke fn again — the
      // primitive is dedupe-while-in-flight, not a memoizer.
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('clears the in-flight slot after a rejection so a retry starts fresh', async () => {
      const adapter = new RedisCacheAdapter(stubCache());
      const fn = jest
        .fn<Promise<number>, []>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(42);

      await expect(adapter.singleFlight('k', fn)).rejects.toThrow('boom');
      await expect(adapter.singleFlight('k', fn)).resolves.toBe(42);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('keeps distinct keys independent — one key does not block another', async () => {
      const adapter = new RedisCacheAdapter(stubCache());
      let resolveA!: (v: number) => void;
      const fnA = jest.fn(
        () =>
          new Promise<number>((resolve) => {
            resolveA = resolve;
          }),
      );
      const fnB = jest.fn(() => Promise.resolve('b'));

      const pendingA = adapter.singleFlight('a', fnA);
      const finishedB = await adapter.singleFlight('b', fnB);

      // B completed without waiting on A.
      expect(finishedB).toBe('b');
      expect(fnA).toHaveBeenCalledTimes(1);
      expect(fnB).toHaveBeenCalledTimes(1);

      resolveA(1);
      await expect(pendingA).resolves.toBe(1);
    });
  });
});
