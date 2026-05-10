import { Cache } from '@nestjs/cache-manager';

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
});
