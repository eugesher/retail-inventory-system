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

import { StockCache } from '../stock.cache';

const correlationId = 'corr-1';
const sampleDto: ProductStockGetResponseDto = {
  productId: 42,
  quantity: 7,
  updatedAt: null,
  items: [],
};

type LoggerMock = Record<'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'trace', jest.Mock>;

const makeLogger = (): LoggerMock => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
  trace: jest.fn(),
});

type CachePortMock = jest.Mocked<Pick<ICachePort, 'get' | 'set' | 'del' | 'delByPrefix' | 'wrap'>>;

describe('StockCache', () => {
  let cache: CachePortMock;
  let logger: LoggerMock;
  let adapter: StockCache;

  beforeEach(() => {
    jest.resetAllMocks();
    cache = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
      delByPrefix: jest.fn(),
      wrap: jest.fn(),
    } as never;
    logger = makeLogger();
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

      expect(result).toBe(sampleDto);
      expect(cache.get).toHaveBeenCalledWith('ris:inventory:stock:42:__all__');
      expect(logger.debug).toHaveBeenCalledWith(
        {
          correlationId,
          productId: 42,
          cacheKey: 'ris:inventory:stock:42:__all__',
          cacheHit: true,
        },
        'Cache hit for stock query',
      );
    });

    it('returns undefined and logs a miss on cache miss', async () => {
      cache.get.mockResolvedValue(undefined);

      const result = await adapter.get({ productId: 42, correlationId });

      expect(result).toBeUndefined();
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
        'ris:inventory:stock:42:head-warehouse,west-warehouse',
      );
    });

    it('returns undefined and warn-logs when cache.get rejects', async () => {
      const err = new Error('cache-read-failed');
      cache.get.mockRejectedValue(err);

      const result = await adapter.get({ productId: 42, correlationId });

      expect(result).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        { err, correlationId, productId: 42, cacheKey: 'ris:inventory:stock:42:__all__' },
        'Failed to read from cache',
      );
    });
  });

  describe('set', () => {
    it('writes under the new prefix with the configured TTL', async () => {
      cache.set.mockResolvedValue(undefined);

      await adapter.set({ productId: 42, data: sampleDto, correlationId });

      expect(cache.set).toHaveBeenCalledWith('ris:inventory:stock:42:__all__', sampleDto, 60000);
      expect(logger.debug).toHaveBeenCalledWith(
        {
          correlationId,
          productId: 42,
          cacheKey: 'ris:inventory:stock:42:__all__',
          ttl: 60000,
        },
        'Cache write for stock query',
      );
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

  describe('invalidate', () => {
    it('returns early without touching cache when items is empty', async () => {
      await adapter.invalidate({ items: [], correlationId });

      expect(cache.delByPrefix).not.toHaveBeenCalled();
    });

    it('wipes both new and legacy prefixes per unique productId', async () => {
      cache.delByPrefix.mockResolvedValue(1);

      await adapter.invalidate({
        items: [
          { productId: 1, storageId: 'a' },
          { productId: 1, storageId: 'b' },
          { productId: 2, storageId: 'a' },
        ],
        correlationId,
      });

      // 2 productIds * 2 prefixes each
      expect(cache.delByPrefix).toHaveBeenCalledTimes(4);
      expect(cache.delByPrefix).toHaveBeenCalledWith('ris:inventory:stock:1:');
      expect(cache.delByPrefix).toHaveBeenCalledWith('stock:1:');
      expect(cache.delByPrefix).toHaveBeenCalledWith('ris:inventory:stock:2:');
      expect(cache.delByPrefix).toHaveBeenCalledWith('stock:2:');
    });

    it('debug-logs total unlinked count on success', async () => {
      cache.delByPrefix.mockImplementation((prefix) =>
        Promise.resolve(prefix.startsWith('ris:inventory:stock:') ? 3 : 0),
      );

      await adapter.invalidate({
        items: [{ productId: 7, storageId: 'a' }],
        correlationId,
      });

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

      await adapter.invalidate({
        items: [{ productId: 9, storageId: 'a' }],
        correlationId,
      });

      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, productIds: [9], itemCount: 1 },
        'No matching stock cache keys to invalidate',
      );
    });

    it('warn-logs and swallows when delByPrefix rejects', async () => {
      const err = new Error('scan-boom');
      cache.delByPrefix.mockRejectedValue(err);

      await adapter.invalidate({
        items: [{ productId: 1, storageId: 'a' }],
        correlationId,
      });

      expect(logger.warn).toHaveBeenCalledWith(
        { err, correlationId, productIds: [1] },
        'Failed to invalidate stock cache',
      );
    });
  });
});
