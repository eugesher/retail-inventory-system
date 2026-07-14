// =============================================================================
// inventory-microservice unit-test conventions — canonical reference
// =============================================================================
// Spec lives in a `spec/` sibling next to the production file; PinoLogger and
// the `ICachePort` dependency are mocked as plain objects with jest fns.
// Cache-key strings are part of the production contract and asserted exactly
// — the spec is the place where `ris:inventory:stock:v3:*` becomes a regression
// boundary.
// =============================================================================

import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';

import { ICachePort } from '@retail-inventory-system/cache';
import { VariantStockView } from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { StockCache } from '../stock.cache';

const correlationId = 'corr-1';
const sampleView: VariantStockView = {
  variantId: 42,
  totalOnHand: 7,
  totalAvailable: 5,
  locations: [
    {
      stockLocationId: 'default-warehouse',
      quantityOnHand: 7,
      quantityAllocated: 1,
      quantityReserved: 1,
      available: 5,
      version: 3,
      updatedAt: null,
    },
  ],
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

  // ADR-049 made the raw `get` / `set` pair private — `getOrLoad` is the only caller,
  // and a public `set` was a way around the post-commit ordering ADR-023 removed public
  // `invalidate` to enforce. These tests drive the same two code paths through the public
  // entry point instead of reaching past it. Nothing about the key shape, the log lines or
  // the TTL band is asserted less precisely for it.
  const makeLoader = (): jest.Mock<Promise<VariantStockView>, []> =>
    jest.fn(() => Promise.resolve(sampleView));
  // A miss: the outer read returns nothing and the single-flight leader runs inline.
  const arrangeMiss = (): void => {
    cache.get.mockResolvedValue(undefined);
    cache.singleFlight.mockImplementation(async (_key, fn) => fn() as Promise<never>);
    cache.set.mockResolvedValue(undefined);
  };

  describe('the read path (through getOrLoad)', () => {
    it('reads under the ris:inventory:stock:v3 prefix with the __all__ sentinel when no stockLocationIds', async () => {
      cache.get.mockResolvedValue(sampleView);

      const result = await adapter.getOrLoad({ variantId: 42, correlationId }, makeLoader());

      expect(result).toBe(sampleView);
      expect(cache.get).toHaveBeenCalledWith('ris:inventory:stock:v3:42:__all__');
      expect(logger.debug).toHaveBeenCalledWith(
        {
          correlationId,
          variantId: 42,
          cacheKey: 'ris:inventory:stock:v3:42:__all__',
          cacheHit: true,
        },
        'Cache hit for stock query',
      );
    });

    it('logs a miss when the key is absent', async () => {
      arrangeMiss();

      await adapter.getOrLoad({ variantId: 42, correlationId }, makeLoader());

      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ cacheHit: false }),
        'Cache miss for stock query',
      );
    });

    it('builds the per-location key (sorted by localeCompare) when stockLocationIds is provided', async () => {
      arrangeMiss();

      await adapter.getOrLoad(
        {
          variantId: 42,
          stockLocationIds: ['west-warehouse', 'head-warehouse'],
          correlationId,
        },
        makeLoader(),
      );

      expect(cache.get).toHaveBeenCalledWith(
        'ris:inventory:stock:v3:42:head-warehouse,west-warehouse',
      );
    });

    it('builds a tenanted key when tenantId is supplied', async () => {
      // ADR-022: tenant segment lives next to the `ris:` root and is
      // opt-in — a present tenantId must flow through every read.
      arrangeMiss();

      await adapter.getOrLoad({ variantId: 42, tenantId: 'store-7', correlationId }, makeLoader());

      expect(cache.get).toHaveBeenCalledWith('ris:t:store-7:inventory:stock:v3:42:__all__');
    });

    it('warn-logs the exact read-failure line when the cache rejects', async () => {
      // CACHE-005: the internal `available: false` signal lets `getOrLoad` skip the
      // write-back path so a Redis-down request emits exactly one warn line instead
      // of duplicating it across read + write. The one-warn count is asserted by the
      // outage tests below; this pins the line's shape.
      const err = new Error('cache-read-failed');
      cache.get.mockRejectedValue(err);

      await expect(adapter.getOrLoad({ variantId: 42, correlationId }, makeLoader())).resolves.toBe(
        sampleView,
      );

      expect(logger.warn).toHaveBeenCalledWith(
        { err, correlationId, variantId: 42, cacheKey: 'ris:inventory:stock:v3:42:__all__' },
        'Failed to read from cache',
      );
    });
  });

  describe('the write-back path (through getOrLoad)', () => {
    it('writes the loaded value under the same key, with a jittered TTL inside ±10% of configured', async () => {
      // ADR-021: ±10% jitter was added to spread expiries of correlated
      // writes. The exact TTL is not asserted; the value must land inside the
      // documented jitter band so a regression in the jitter math (sign flip,
      // off-by-one floor) trips the spec.
      arrangeMiss();

      await adapter.getOrLoad({ variantId: 42, correlationId }, makeLoader());

      expect(cache.set).toHaveBeenCalledTimes(1);
      const [calledKey, calledData, calledTtl] = cache.set.mock.calls[0];
      expect(calledKey).toBe('ris:inventory:stock:v3:42:__all__');
      expect(calledData).toBe(sampleView);
      expect(calledTtl).toBeGreaterThanOrEqual(60000 * 0.9 - 1);
      expect(calledTtl).toBeLessThanOrEqual(60000 * 1.1);
      expect(logger.debug).toHaveBeenCalledWith(
        {
          correlationId,
          variantId: 42,
          cacheKey: 'ris:inventory:stock:v3:42:__all__',
          ttl: calledTtl,
        },
        'Cache write for stock query',
      );
    });

    it('spreads TTLs across many writes inside the [ttl*0.9, ttl*1.1] band', async () => {
      // ADR-021 jitter contract — the band is uniform around the
      // configured TTL. Sampling many writes catches a regression where
      // jitter collapses to 0 or skews to one side of the mean.
      arrangeMiss();
      const ttls: number[] = [];
      for (let i = 0; i < 200; i++) {
        await adapter.getOrLoad({ variantId: i, correlationId }, makeLoader());
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

    it('warn-logs and swallows when the write-back rejects — the caller still gets its value', async () => {
      const err = new Error('cache-write-failed');
      cache.get.mockResolvedValue(undefined);
      cache.singleFlight.mockImplementation(async (_key, fn) => fn() as Promise<never>);
      cache.set.mockRejectedValue(err);

      await expect(adapter.getOrLoad({ variantId: 42, correlationId }, makeLoader())).resolves.toBe(
        sampleView,
      );

      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err, variantId: 42 }),
        'Failed to write to cache',
      );
    });
  });

  describe('getOrLoad', () => {
    // ADR-021: getOrLoad is the cache-aside + single-flight + jitter
    // entry point used by QueryAvailabilityUseCase. These tests cover the
    // contract at the StockCache level; the underlying single-flight primitive
    // is separately verified in libs/cache/spec/redis-cache.adapter.spec.ts.

    const loader = (): jest.Mock<Promise<VariantStockView>, []> =>
      jest.fn(() => Promise.resolve(sampleView));

    it('returns the cached value without invoking the loader on a hit', async () => {
      cache.get.mockResolvedValue(sampleView);
      const load = loader();

      const result = await adapter.getOrLoad({ variantId: 42, correlationId }, load);

      expect(result).toBe(sampleView);
      expect(load).not.toHaveBeenCalled();
      expect(cache.singleFlight).not.toHaveBeenCalled();
    });

    it('routes a miss through cache.singleFlight under the correct key', async () => {
      cache.get.mockResolvedValue(undefined);
      const load = loader();
      cache.singleFlight.mockImplementation(async (_key, fn) => fn() as Promise<never>);
      cache.set.mockResolvedValue(undefined);

      const result = await adapter.getOrLoad({ variantId: 42, correlationId }, load);

      expect(result).toBe(sampleView);
      expect(cache.singleFlight).toHaveBeenCalledWith(
        'ris:inventory:stock:v3:42:__all__',
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
      const load = jest.fn<Promise<VariantStockView>, []>().mockRejectedValue(err);
      cache.singleFlight.mockImplementation(async (_key, fn) => fn() as Promise<never>);

      await expect(adapter.getOrLoad({ variantId: 42, correlationId }, load)).rejects.toBe(err);
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
      const load = jest.fn(() => Promise.resolve(sampleView));

      const result = await adapter.getOrLoad({ variantId: 42, correlationId }, load);

      expect(result).toBe(sampleView);
      expect(load).toHaveBeenCalledTimes(1);
      expect(cache.set).not.toHaveBeenCalled();
      expect(cache.singleFlight).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err, variantId: 42 }),
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
      const load = jest.fn(() => Promise.resolve(sampleView));

      const result = await adapter.getOrLoad({ variantId: 42, correlationId }, load);

      expect(result).toBe(sampleView);
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
      const load = jest.fn(() => Promise.resolve(sampleView));

      const result = await adapter.getOrLoad({ variantId: 42, correlationId }, load);

      expect(result).toBe(sampleView);
      expect(load).toHaveBeenCalledTimes(1);
      expect(cache.set).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: writeErr, variantId: 42 }),
        'Failed to write to cache',
      );
    });
  });

  describe('withInvalidation', () => {
    // ADR-023: `withInvalidation` is the only public path that fires the
    // internal prefix-delete. These tests cover the contract at the
    // StockCache level: work-then-invalidate ordering on success,
    // no-invalidate-on-rejection, no-invalidate-on-empty-items, **exactly one
    // prefix per unique variantId**, and the tenant scoping.
    //
    // The one-per-variant count is pinned deliberately. It used to be FIVE — the live
    // `v3` key plus four retired shapes swept for a rolling-deploy transition window that
    // never happened (ISSUE-03). A removal without a pinned absence is unguarded, so the
    // legacy prefixes are asserted NOT to be called: that is what stops the sweep being
    // quietly re-added and putting four dead SCANs back on every stock write.

    it('runs the prefix delete after work resolves, and returns the work result', async () => {
      cache.delByPrefix.mockResolvedValue(1);

      const order: string[] = [];
      const work = jest.fn((): Promise<'work-result'> => {
        order.push('work');
        return Promise.resolve('work-result');
      });
      const resolveItems = jest.fn(() => {
        order.push('resolveItems');
        return [{ variantId: 1, stockLocationId: 'a' }];
      });

      const result = await adapter.withInvalidation(work, resolveItems, { correlationId });

      // Work must complete before resolveItems runs (the helper reads the
      // work result to decide what to invalidate), and the prefix delete
      // must be the last step.
      expect(result).toBe('work-result');
      expect(work).toHaveBeenCalledTimes(1);
      expect(resolveItems).toHaveBeenCalledWith('work-result');
      expect(order).toEqual(['work', 'resolveItems']);
      // ONE prefix per variantId — one Redis SCAN, not five (ISSUE-03).
      expect(cache.delByPrefix).toHaveBeenCalledTimes(1);
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

    it('wipes exactly ONE live v3 prefix per unique variantId — and no retired shape', async () => {
      cache.delByPrefix.mockResolvedValue(1);

      await adapter.withInvalidation(
        () => Promise.resolve(),
        () => [
          { variantId: 1, stockLocationId: 'a' },
          { variantId: 1, stockLocationId: 'b' },
          { variantId: 2, stockLocationId: 'a' },
        ],
        { correlationId },
      );

      // 2 unique variantIds → 2 SCANs. Three items, two variants: the dedupe by variantId
      // is what makes a multi-line write cost one SCAN per variant, not one per line.
      expect(cache.delByPrefix).toHaveBeenCalledTimes(2);
      expect(cache.delByPrefix).toHaveBeenCalledWith('ris:inventory:stock:v3:1:');
      expect(cache.delByPrefix).toHaveBeenCalledWith('ris:inventory:stock:v3:2:');

      // **The pinned absence.** Each of these was a SCAN on every stock write that could
      // never match anything — and could not have been served if it had, since no read path
      // builds a retired key. Re-adding any of them re-adds the tax (ISSUE-03).
      for (const retired of [
        'ris:inventory:stock:v2:1:',
        'ris:inventory:stock:v1:1:',
        'ris:inventory:stock:1:',
        'stock:1:',
      ]) {
        expect(cache.delByPrefix).not.toHaveBeenCalledWith(retired);
      }
    });

    it('scopes the wipe to the supplied tenant', async () => {
      // ADR-022: a tenant-scoped key carries the `t:` segment; the wipe must carry it too,
      // or one tenant's write clears another's entries.
      cache.delByPrefix.mockResolvedValue(1);

      await adapter.withInvalidation(
        () => Promise.resolve(),
        () => [{ variantId: 1, stockLocationId: 'a' }],
        { tenantId: 'store-7', correlationId },
      );

      expect(cache.delByPrefix).toHaveBeenCalledTimes(1);
      expect(cache.delByPrefix).toHaveBeenCalledWith('ris:t:store-7:inventory:stock:v3:1:');
    });

    it('debug-logs total unlinked count on success', async () => {
      cache.delByPrefix.mockImplementation((prefix) =>
        Promise.resolve(prefix.startsWith('ris:inventory:stock:v3:') ? 3 : 0),
      );

      await adapter.withInvalidation(
        () => Promise.resolve(),
        () => [{ variantId: 7, stockLocationId: 'a' }],
        { correlationId },
      );

      expect(logger.debug).toHaveBeenCalledWith(
        {
          correlationId,
          variantIds: [7],
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
        () => [{ variantId: 9, stockLocationId: 'a' }],
        { correlationId },
      );

      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, variantIds: [9], itemCount: 1 },
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
          () => [{ variantId: 1, stockLocationId: 'a' }],
          { correlationId },
        ),
      ).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledWith(
        { err, correlationId, variantIds: [1] },
        'Failed to invalidate stock cache',
      );
    });
  });
});
