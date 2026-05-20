// =============================================================================
// inventory-microservice unit-test conventions — canonical reference
// =============================================================================
// Spec lives in a `spec/` sibling next to the production file; PinoLogger and
// the `ICachePort` dependency are mocked as plain objects with jest fns.
// Cache-key strings are part of the production contract and asserted exactly
// — the spec is the place where `ris:inventory:stock:*` becomes a regression
// boundary.
// =============================================================================

import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';

import { ICachePort } from '@retail-inventory-system/cache';
import { ProductStockGetResponseDto } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { StockCache } from '../stock.cache';

const correlationId = 'corr-1';
const sampleDto: ProductStockGetResponseDto = {
  productId: 42,
  quantity: 7,
  updatedAt: null,
  items: [],
};

type CachePortMock = jest.Mocked<
  Pick<ICachePort, 'get' | 'set' | 'del' | 'delByPrefix' | 'wrap' | 'singleFlight'>
>;

describe('StockCache', () => {
  let cache: CachePortMock;
  let logger: PinoLoggerMock;
  let adapter: StockCache;

  beforeEach(() => {
    jest.resetAllMocks();
    cache = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      delByPrefix: jest.fn(),
      wrap: jest.fn(),
      singleFlight: jest.fn(),
    } as never;
    logger = makePinoLoggerMock();
    const config = { get: jest.fn().mockReturnValue(60000) };
    adapter = new StockCache(
      cache as unknown as ICachePort,
      config as unknown as ConfigService,
      logger as unknown as PinoLogger,
    );
  });

  describe('get', () => {
    it('reads under the new ris:inventory:stock prefix with __all__ sentinel when no storageIds', async () => {
      cache.get.mockResolvedValue(sampleDto);

      const result = await adapter.get({ productId: 42, correlationId });

      expect(result).toEqual({ value: sampleDto, available: true });
      expect(cache.get).toHaveBeenCalledWith('ris:inventory:stock:v1:42:__all__');
      expect(logger.debug).toHaveBeenCalledWith(
        {
          correlationId,
          productId: 42,
          cacheKey: 'ris:inventory:stock:v1:42:__all__',
          cacheHit: true,
        },
        'Cache hit for stock query',
      );
    });

    it('returns { value: undefined, available: true } and logs a miss on cache miss', async () => {
      cache.get.mockResolvedValue(undefined);

      const result = await adapter.get({ productId: 42, correlationId });

      expect(result).toEqual({ value: undefined, available: true });
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ cacheHit: false }),
        'Cache miss for stock query',
      );
    });

    it('builds the per-storage key (sorted by localeCompare) when storageIds is provided', async () => {
      cache.get.mockResolvedValue(undefined);

      await adapter.get({
        productId: 42,
        storageIds: ['west-warehouse', 'head-warehouse'],
        correlationId,
      });

      expect(cache.get).toHaveBeenCalledWith(
        'ris:inventory:stock:v1:42:head-warehouse,west-warehouse',
      );
    });

    it('builds a tenanted key when tenantId is supplied', async () => {
      // ADR-022: tenant segment lives next to the `ris:` root and is
      // opt-in — a present tenantId must flow through every read.
      cache.get.mockResolvedValue(undefined);

      await adapter.get({ productId: 42, tenantId: 'store-7', correlationId });

      expect(cache.get).toHaveBeenCalledWith('ris:t:store-7:inventory:stock:v1:42:__all__');
    });

    it('returns { value: undefined, available: false } and warn-logs when cache.get rejects', async () => {
      // CACHE-005: the `available: false` signal lets `getOrLoad` skip the
      // write-back path so a Redis-down request emits exactly one warn
      // line instead of duplicating it across read + write.
      const err = new Error('cache-read-failed');
      cache.get.mockRejectedValue(err);

      const result = await adapter.get({ productId: 42, correlationId });

      expect(result).toEqual({ value: undefined, available: false });
      expect(logger.warn).toHaveBeenCalledWith(
        { err, correlationId, productId: 42, cacheKey: 'ris:inventory:stock:v1:42:__all__' },
        'Failed to read from cache',
      );
    });
  });

  describe('set', () => {
    it('writes under the new prefix with a jittered TTL inside ±10% of configured', async () => {
      // ADR-021: ±10% jitter was added to spread expiries of correlated
      // writes. The exact TTL is no longer asserted; instead the test
      // asserts the value lands inside the documented jitter band so a
      // regression in the jitter math (sign flip, off-by-one floor) trips
      // the spec.
      cache.set.mockResolvedValue(undefined);

      await adapter.set({ productId: 42, data: sampleDto, correlationId });

      expect(cache.set).toHaveBeenCalledTimes(1);
      const [calledKey, calledData, calledTtl] = cache.set.mock.calls[0];
      expect(calledKey).toBe('ris:inventory:stock:v1:42:__all__');
      expect(calledData).toBe(sampleDto);
      expect(calledTtl).toBeGreaterThanOrEqual(60000 * 0.9 - 1);
      expect(calledTtl).toBeLessThanOrEqual(60000 * 1.1);
      expect(logger.debug).toHaveBeenCalledWith(
        {
          correlationId,
          productId: 42,
          cacheKey: 'ris:inventory:stock:v1:42:__all__',
          ttl: calledTtl,
        },
        'Cache write for stock query',
      );
    });

    it('spreads TTLs across many writes inside the [ttl*0.9, ttl*1.1] band', async () => {
      // ADR-021 jitter contract — the band is uniform around the
      // configured TTL. Sampling many writes catches a regression where
      // jitter collapses to 0 or skews to one side of the mean.
      cache.set.mockResolvedValue(undefined);
      const ttls: number[] = [];
      for (let i = 0; i < 200; i++) {
        await adapter.set({ productId: i, data: sampleDto, correlationId });
        const lastCall = cache.set.mock.calls[cache.set.mock.calls.length - 1];
        ttls.push(lastCall[2]!);
      }

      const min = Math.min(...ttls);
      const max = Math.max(...ttls);
      const mean = ttls.reduce((a, b) => a + b, 0) / ttls.length;

      // Floor on the lower bound; floor+inclusive upper avoids off-by-one.
      expect(min).toBeGreaterThanOrEqual(60000 * 0.9 - 1);
      expect(max).toBeLessThanOrEqual(60000 * 1.1);
      // Spread must be non-trivial — without jitter min === max, and with
      // healthy ±10% jitter we expect at least a 1000ms range across 200
      // samples (well under the ~12000ms full band but resilient to RNG).
      expect(max - min).toBeGreaterThan(1000);
      // Mean should sit near the configured TTL (within 2% over 200 samples).
      expect(mean).toBeGreaterThan(60000 * 0.98);
      expect(mean).toBeLessThan(60000 * 1.02);
    });

    it('warn-logs and swallows when cache.set rejects', async () => {
      const err = new Error('cache-write-failed');
      cache.set.mockRejectedValue(err);

      await expect(
        adapter.set({ productId: 42, data: sampleDto, correlationId }),
      ).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err, productId: 42 }),
        'Failed to write to cache',
      );
    });
  });

  describe('getOrLoad', () => {
    // ADR-021: getOrLoad is the cache-aside + single-flight + jitter
    // entry point used by GetStockUseCase. These tests cover the contract
    // at the StockCache level; the underlying single-flight primitive is
    // separately verified in libs/cache/spec/redis-cache.adapter.spec.ts.

    const loader = (): jest.Mock<Promise<ProductStockGetResponseDto>, []> =>
      jest.fn(() => Promise.resolve(sampleDto));

    it('returns the cached value without invoking the loader on a hit', async () => {
      cache.get.mockResolvedValue(sampleDto);
      const load = loader();

      const result = await adapter.getOrLoad({ productId: 42, correlationId }, load);

      expect(result).toBe(sampleDto);
      expect(load).not.toHaveBeenCalled();
      expect(cache.singleFlight).not.toHaveBeenCalled();
    });

    it('routes a miss through cache.singleFlight under the correct key', async () => {
      cache.get.mockResolvedValue(undefined);
      const load = loader();
      cache.singleFlight.mockImplementation(async (_key, fn) => fn() as Promise<never>);
      cache.set.mockResolvedValue(undefined);

      const result = await adapter.getOrLoad({ productId: 42, correlationId }, load);

      expect(result).toBe(sampleDto);
      expect(cache.singleFlight).toHaveBeenCalledWith(
        'ris:inventory:stock:v1:42:__all__',
        expect.any(Function),
      );
      expect(load).toHaveBeenCalledTimes(1);
      // The leader writes the result back with a jittered TTL.
      expect(cache.set).toHaveBeenCalledTimes(1);
      const calledTtl = cache.set.mock.calls[0][2]!;
      expect(calledTtl).toBeGreaterThanOrEqual(60000 * 0.9 - 1);
      expect(calledTtl).toBeLessThanOrEqual(60000 * 1.1);
    });

    it('propagates loader rejection without writing to cache', async () => {
      const err = new Error('db-fail');
      cache.get.mockResolvedValue(undefined);
      const load = jest.fn<Promise<ProductStockGetResponseDto>, []>().mockRejectedValue(err);
      cache.singleFlight.mockImplementation(async (_key, fn) => fn() as Promise<never>);

      await expect(adapter.getOrLoad({ productId: 42, correlationId }, load)).rejects.toBe(err);
      expect(cache.set).not.toHaveBeenCalled();
    });

    // CACHE-005: the three outage shapes. Each must produce exactly one
    // warn line per `getOrLoad` call so operators tuning alerts on
    // "Failed to read/write from cache" get an undistorted incident count.

    it('complete outage — emits exactly one warn and returns the loader result without calling set', async () => {
      // Both read and write would fail if attempted. The `available: false`
      // signal from `get` short-circuits the single-flight + set path, so
      // only the single read-failure warn lands. `set` is never reached.
      const err = new Error('redis-down');
      cache.get.mockRejectedValue(err);
      cache.set.mockRejectedValue(err);
      const load = jest.fn(() => Promise.resolve(sampleDto));

      const result = await adapter.getOrLoad({ productId: 42, correlationId }, load);

      expect(result).toBe(sampleDto);
      expect(load).toHaveBeenCalledTimes(1);
      expect(cache.set).not.toHaveBeenCalled();
      expect(cache.singleFlight).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err, productId: 42 }),
        'Failed to read from cache',
      );
    });

    it('read-only outage — set is not attempted even though it would succeed', async () => {
      // Verifies the `available` flag governs the skip independently of
      // whether `set` would have succeeded — a Redis that just lost read
      // capability (rare but possible during failover) should not have
      // its write-back attempted blindly.
      const err = new Error('read-failed');
      cache.get.mockRejectedValue(err);
      cache.set.mockResolvedValue(undefined);
      const load = jest.fn(() => Promise.resolve(sampleDto));

      const result = await adapter.getOrLoad({ productId: 42, correlationId }, load);

      expect(result).toBe(sampleDto);
      expect(load).toHaveBeenCalledTimes(1);
      expect(cache.set).not.toHaveBeenCalled();
      expect(cache.singleFlight).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
    });

    it('write-only outage — single warn from set, DB result still returned', async () => {
      // Clean miss on read so the leader joins the single-flight cohort,
      // runs the loader, then attempts `set` which fails. The set-failure
      // warn is the only warn line; no read warn was emitted upstream.
      const writeErr = new Error('write-failed');
      cache.get.mockResolvedValue(undefined);
      cache.set.mockRejectedValue(writeErr);
      cache.singleFlight.mockImplementation(async (_key, fn) => fn() as Promise<never>);
      const load = jest.fn(() => Promise.resolve(sampleDto));

      const result = await adapter.getOrLoad({ productId: 42, correlationId }, load);

      expect(result).toBe(sampleDto);
      expect(load).toHaveBeenCalledTimes(1);
      expect(cache.set).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: writeErr, productId: 42 }),
        'Failed to write to cache',
      );
    });
  });

  describe('withInvalidation', () => {
    // ADR-023: `withInvalidation` is the only public path that fires the
    // internal prefix-delete. These tests cover the contract at the
    // StockCache level: work-then-invalidate ordering on success,
    // no-invalidate-on-rejection, no-invalidate-on-empty-items, the
    // ADR-022 v1 + pre-v1 + pre-ADR-016 fan-out, and the tenant scoping.

    it('runs the prefix delete after work resolves, and returns the work result', async () => {
      cache.delByPrefix.mockResolvedValue(1);

      const order: string[] = [];
      const work = jest.fn((): Promise<'work-result'> => {
        order.push('work');
        return Promise.resolve('work-result');
      });
      const resolveItems = jest.fn(() => {
        order.push('resolveItems');
        return [{ productId: 1, storageId: 'a' }];
      });

      const result = await adapter.withInvalidation(work, resolveItems, { correlationId });

      // Work must complete before resolveItems runs (the helper reads the
      // work result to decide what to invalidate), and the prefix delete
      // must be the last step.
      expect(result).toBe('work-result');
      expect(work).toHaveBeenCalledTimes(1);
      expect(resolveItems).toHaveBeenCalledWith('work-result');
      expect(order).toEqual(['work', 'resolveItems']);
      // Three prefixes per productId (ADR-022 transition window).
      expect(cache.delByPrefix).toHaveBeenCalledTimes(3);
      const workOrder = work.mock.invocationCallOrder[0];
      const delOrder = cache.delByPrefix.mock.invocationCallOrder[0];
      expect(workOrder).toBeLessThan(delOrder);
    });

    it('does not invoke the prefix delete when work rejects', async () => {
      const err = new Error('work-fail');
      const work = jest.fn().mockRejectedValue(err);
      const resolveItems = jest.fn();

      await expect(adapter.withInvalidation(work, resolveItems, { correlationId })).rejects.toBe(
        err,
      );

      // The helper rethrows before resolveItems can run, so the prefix
      // delete is unreachable. This is the type-system contract from
      // ADR-023 expressed at runtime.
      expect(resolveItems).not.toHaveBeenCalled();
      expect(cache.delByPrefix).not.toHaveBeenCalled();
    });

    it('skips the prefix delete when resolveItems returns []', async () => {
      const work = jest.fn().mockResolvedValue(undefined);
      const resolveItems = jest.fn(() => []);

      await adapter.withInvalidation(work, resolveItems, { correlationId });

      expect(resolveItems).toHaveBeenCalledTimes(1);
      expect(cache.delByPrefix).not.toHaveBeenCalled();
    });

    it('wipes the v1 + pre-v1 + pre-ADR-016 prefixes per unique productId', async () => {
      // ADR-022 transition window: every invalidation fans out to three
      // prefixes per productId so in-flight entries from any of the three
      // historical shapes are wiped on the first post-deploy invalidate.
      cache.delByPrefix.mockResolvedValue(1);

      await adapter.withInvalidation(
        () => Promise.resolve(),
        () => [
          { productId: 1, storageId: 'a' },
          { productId: 1, storageId: 'b' },
          { productId: 2, storageId: 'a' },
        ],
        { correlationId },
      );

      // 2 productIds * 3 prefixes each
      expect(cache.delByPrefix).toHaveBeenCalledTimes(6);
      expect(cache.delByPrefix).toHaveBeenCalledWith('ris:inventory:stock:v1:1:');
      expect(cache.delByPrefix).toHaveBeenCalledWith('ris:inventory:stock:1:');
      expect(cache.delByPrefix).toHaveBeenCalledWith('stock:1:');
      expect(cache.delByPrefix).toHaveBeenCalledWith('ris:inventory:stock:v1:2:');
      expect(cache.delByPrefix).toHaveBeenCalledWith('ris:inventory:stock:2:');
      expect(cache.delByPrefix).toHaveBeenCalledWith('stock:2:');
    });

    it('scopes the v1 wipe to the supplied tenant but keeps the pre-v1 wipes tenant-agnostic', async () => {
      // ADR-022: the pre-v1 and pre-ADR-016 shapes never carried a tenant
      // segment, so the transition-window wipes are unconditionally
      // single-tenant. Only the current v1 shape gets the `t:` prefix.
      cache.delByPrefix.mockResolvedValue(1);

      await adapter.withInvalidation(
        () => Promise.resolve(),
        () => [{ productId: 1, storageId: 'a' }],
        { tenantId: 'store-7', correlationId },
      );

      expect(cache.delByPrefix).toHaveBeenCalledTimes(3);
      expect(cache.delByPrefix).toHaveBeenCalledWith('ris:t:store-7:inventory:stock:v1:1:');
      expect(cache.delByPrefix).toHaveBeenCalledWith('ris:inventory:stock:1:');
      expect(cache.delByPrefix).toHaveBeenCalledWith('stock:1:');
    });

    it('debug-logs total unlinked count on success', async () => {
      // Match only the v1 prefix; the pre-v1 and pre-ADR-016 transition
      // prefixes return 0 (no in-flight stale entries in this test).
      cache.delByPrefix.mockImplementation((prefix) =>
        Promise.resolve(prefix.startsWith('ris:inventory:stock:v1:') ? 3 : 0),
      );

      await adapter.withInvalidation(
        () => Promise.resolve(),
        () => [{ productId: 7, storageId: 'a' }],
        { correlationId },
      );

      expect(logger.debug).toHaveBeenCalledWith(
        {
          correlationId,
          productIds: [7],
          itemCount: 1,
          keyCount: 3,
        },
        'Stock cache invalidated via prefix delete',
      );
    });

    it('debug-logs "no matching keys" when every delByPrefix returns 0', async () => {
      cache.delByPrefix.mockResolvedValue(0);

      await adapter.withInvalidation(
        () => Promise.resolve(),
        () => [{ productId: 9, storageId: 'a' }],
        { correlationId },
      );

      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, productIds: [9], itemCount: 1 },
        'No matching stock cache keys to invalidate',
      );
    });

    it('warn-logs and swallows when delByPrefix rejects', async () => {
      const err = new Error('scan-boom');
      cache.delByPrefix.mockRejectedValue(err);

      // The prefix-delete failure must not bubble up — the cache adapter
      // swallows it so the surrounding write path's success is unaffected.
      await expect(
        adapter.withInvalidation(
          () => Promise.resolve(),
          () => [{ productId: 1, storageId: 'a' }],
          { correlationId },
        ),
      ).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledWith(
        { err, correlationId, productIds: [1] },
        'Failed to invalidate stock cache',
      );
    });
  });
});
