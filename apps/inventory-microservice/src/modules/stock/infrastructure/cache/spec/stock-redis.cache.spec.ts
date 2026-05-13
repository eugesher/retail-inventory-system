// =============================================================================
// inventory-microservice unit-test conventions — canonical reference
// =============================================================================
// Same conventions established in the cache-layer audit pass continue to apply
// to the per-module hexagonal layout introduced in task-08. Specs live in
// `spec/` sibling folders next to the production file; PinoLogger is mocked as
// a plain LoggerMock; structural mocks for Cache / KeyvRedis avoid real Redis;
// cache-key strings are part of the production contract and asserted exactly.
// =============================================================================

import { Cache } from '@nestjs/cache-manager';
import { ConfigService } from '@nestjs/config';
import KeyvRedis from '@keyv/redis';
import { PinoLogger } from 'nestjs-pino';

import { ProductStockGetResponseDto } from '@retail-inventory-system/contracts';

import { StockRedisCache } from '../stock-redis.cache';

const correlationId = 'corr-1';
const sampleDto: ProductStockGetResponseDto = {
  productId: 42,
  quantity: 7,
  updatedAt: null,
  items: [],
};

type LoggerMock = Record<'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'trace', jest.Mock>;
interface ICacheMock {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  primary: { store: unknown };
}

const makeLogger = (): LoggerMock => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
  trace: jest.fn(),
});

const makeCache = (): ICacheMock => ({
  get: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
  primary: { store: undefined },
});

const asyncIterableOf = (batches: string[][]): AsyncIterable<string[]> => ({
  [Symbol.asyncIterator]: async function* (): AsyncGenerator<string[]> {
    await Promise.resolve();
    for (const batch of batches) yield batch;
  },
});

const makeKeyvRedisStub = (overrides: {
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

describe('StockRedisCache', () => {
  let cache: ICacheMock;
  let logger: LoggerMock;
  let adapter: StockRedisCache;

  beforeEach(() => {
    jest.resetAllMocks();
    cache = makeCache();
    logger = makeLogger();
    const config = { get: jest.fn().mockReturnValue(60000) };
    adapter = new StockRedisCache(
      cache as unknown as Cache,
      config as unknown as ConfigService,
      logger as unknown as PinoLogger,
    );
  });

  describe('get', () => {
    it('returns the cached DTO and logs a hit on cache hit', async () => {
      cache.get.mockResolvedValue(sampleDto);

      const result = await adapter.get({ productId: 42, correlationId });

      expect(result).toBe(sampleDto);
      expect(cache.get).toHaveBeenCalledWith('stock:42:*');
      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, productId: 42, cacheKey: 'stock:42:*', cacheHit: true },
        'Cache hit for stock query',
      );
    });

    it('returns undefined and logs a miss on cache miss', async () => {
      cache.get.mockResolvedValue(undefined);

      const result = await adapter.get({ productId: 42, correlationId });

      expect(result).toBeUndefined();
      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, productId: 42, cacheKey: 'stock:42:*', cacheHit: false },
        'Cache miss for stock query',
      );
    });

    it('builds the per-storage key when storageIds is provided', async () => {
      cache.get.mockResolvedValue(undefined);

      await adapter.get({ productId: 42, storageIds: ['head-warehouse'], correlationId });

      expect(cache.get).toHaveBeenCalledWith('stock:42:head-warehouse');
    });

    it('returns undefined and warn-logs when cache.get rejects', async () => {
      const err = new Error('redis-down');
      cache.get.mockRejectedValue(err);

      const result = await adapter.get({ productId: 42, correlationId });

      expect(result).toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        { err, correlationId, productId: 42, cacheKey: 'stock:42:*' },
        'Failed to read from cache',
      );
    });
  });

  describe('set', () => {
    it('writes with the configured TTL and debug-logs on success', async () => {
      cache.set.mockResolvedValue(undefined);

      await adapter.set({ productId: 42, data: sampleDto, correlationId });

      expect(cache.set).toHaveBeenCalledWith('stock:42:*', sampleDto, 60000);
      expect(logger.debug).toHaveBeenCalledWith(
        {
          correlationId,
          productId: 42,
          cacheKey: 'stock:42:*',
          ttl: 60000,
        },
        'Cache write for stock query',
      );
    });

    it('warn-logs and swallows when cache.set rejects', async () => {
      const err = new Error('redis-write-fail');
      cache.set.mockRejectedValue(err);

      await expect(
        adapter.set({ productId: 42, data: sampleDto, correlationId }),
      ).resolves.toBeUndefined();

      expect(logger.warn).toHaveBeenCalledWith(
        { err, correlationId, productId: 42, cacheKey: 'stock:42:*' },
        'Failed to write to cache',
      );
    });
  });

  describe('invalidate', () => {
    it('returns early without touching cache when items is empty', async () => {
      await adapter.invalidate({ items: [], correlationId });

      expect(cache.get).not.toHaveBeenCalled();
      expect(cache.set).not.toHaveBeenCalled();
      expect(cache.del).not.toHaveBeenCalled();
    });

    describe('non-Redis backend (named-key fallback)', () => {
      beforeEach(() => {
        cache.primary.store = {};
      });

      it('deletes both unfiltered and per-storage keys per item', async () => {
        cache.del.mockResolvedValue(undefined);

        await adapter.invalidate({
          items: [{ productId: 1, storageId: 'head-warehouse' }],
          correlationId,
        });

        expect(cache.del).toHaveBeenCalledWith('stock:1:*');
        expect(cache.del).toHaveBeenCalledWith('stock:1:head-warehouse');
        expect(cache.del).toHaveBeenCalledTimes(2);
        expect(logger.debug).toHaveBeenCalledWith(
          { correlationId, itemCount: 1, keyCount: 2 },
          'Stock cache invalidated via named-key fallback',
        );
      });

      it('warn-logs when cache.del rejects', async () => {
        const err = new Error('del-fail');
        cache.del.mockRejectedValue(err);

        await adapter.invalidate({
          items: [{ productId: 1, storageId: 'head-warehouse' }],
          correlationId,
        });

        expect(logger.warn).toHaveBeenCalledWith(
          { err, correlationId, itemCount: 1 },
          'Failed to invalidate stock cache (fallback path)',
        );
      });
    });

    describe('Redis backend (SCAN + UNLINK)', () => {
      it('SCANs by productId, UNLINKs the deduped key set, debug-logs on success', async () => {
        const scanIterator = jest.fn(() =>
          asyncIterableOf([['stock:1:*', 'stock:1:head-warehouse']]),
        );
        const unlink = jest.fn().mockResolvedValue(2);
        cache.primary.store = makeKeyvRedisStub({ client: { scanIterator, unlink } });

        await adapter.invalidate({
          items: [{ productId: 1, storageId: 'head-warehouse' }],
          correlationId,
        });

        expect(scanIterator).toHaveBeenCalledWith({ MATCH: 'stock:1:*', COUNT: 100 });
        expect(unlink).toHaveBeenCalledWith(['stock:1:*', 'stock:1:head-warehouse']);
        expect(logger.debug).toHaveBeenCalledWith(
          { correlationId, productIds: [1], itemCount: 1, keyCount: 2 },
          'Stock cache invalidated via SCAN+UNLINK',
        );
      });

      it('applies KeyvRedis namespace + separator to the SCAN pattern when configured', async () => {
        const scanIterator = jest.fn(() => asyncIterableOf([[]]));
        const unlink = jest.fn();
        cache.primary.store = makeKeyvRedisStub({
          client: { scanIterator, unlink },
          namespace: 'tenant-a',
          keyPrefixSeparator: '::',
        });

        await adapter.invalidate({
          items: [{ productId: 7, storageId: 'head-warehouse' }],
          correlationId,
        });

        expect(scanIterator).toHaveBeenCalledWith({ MATCH: 'tenant-a::stock:7:*', COUNT: 100 });
      });

      it('deduplicates keys returned across multiple SCAN cycles', async () => {
        const scanIterator = jest.fn(() =>
          asyncIterableOf([['stock:1:*'], ['stock:1:head-warehouse', 'stock:1:*']]),
        );
        const unlink = jest.fn().mockResolvedValue(2);
        cache.primary.store = makeKeyvRedisStub({ client: { scanIterator, unlink } });

        await adapter.invalidate({
          items: [{ productId: 1, storageId: 'head-warehouse' }],
          correlationId,
        });

        expect(unlink).toHaveBeenCalledTimes(1);
        expect(unlink).toHaveBeenCalledWith(['stock:1:*', 'stock:1:head-warehouse']);
      });

      it('SCANs once per unique productId', async () => {
        const scanIterator = jest.fn(() => asyncIterableOf([[]]));
        const unlink = jest.fn();
        cache.primary.store = makeKeyvRedisStub({ client: { scanIterator, unlink } });

        await adapter.invalidate({
          items: [
            { productId: 1, storageId: 'a' },
            { productId: 1, storageId: 'b' },
            { productId: 2, storageId: 'a' },
          ],
          correlationId,
        });

        expect(scanIterator).toHaveBeenCalledTimes(2);
        expect(scanIterator).toHaveBeenNthCalledWith(1, { MATCH: 'stock:1:*', COUNT: 100 });
        expect(scanIterator).toHaveBeenNthCalledWith(2, { MATCH: 'stock:2:*', COUNT: 100 });
      });

      it('warn-logs and skips UNLINK when SCAN throws', async () => {
        const err = new Error('scan-boom');
        async function* errorIter(): AsyncGenerator<string[]> {
          await Promise.resolve();
          yield ['stock:1:*'];
          throw err;
        }
        const scanIterator = jest.fn(() => errorIter());
        const unlink = jest.fn();
        cache.primary.store = makeKeyvRedisStub({ client: { scanIterator, unlink } });

        await adapter.invalidate({
          items: [{ productId: 1, storageId: 'head-warehouse' }],
          correlationId,
        });

        expect(unlink).not.toHaveBeenCalled();
        expect(logger.warn).toHaveBeenCalledWith(
          { err, correlationId, productIds: [1] },
          'SCAN failed during stock cache invalidation',
        );
      });

      it('debug-logs and skips UNLINK when SCAN returns no keys', async () => {
        const scanIterator = jest.fn(() => asyncIterableOf([[]]));
        const unlink = jest.fn();
        cache.primary.store = makeKeyvRedisStub({ client: { scanIterator, unlink } });

        await adapter.invalidate({
          items: [{ productId: 1, storageId: 'head-warehouse' }],
          correlationId,
        });

        expect(unlink).not.toHaveBeenCalled();
        expect(logger.debug).toHaveBeenCalledWith(
          { correlationId, productIds: [1], itemCount: 1 },
          'No matching stock cache keys to invalidate',
        );
      });

      it('warn-logs when UNLINK throws', async () => {
        const err = new Error('unlink-boom');
        const scanIterator = jest.fn(() => asyncIterableOf([['stock:1:*']]));
        const unlink = jest.fn().mockRejectedValue(err);
        cache.primary.store = makeKeyvRedisStub({ client: { scanIterator, unlink } });

        await adapter.invalidate({
          items: [{ productId: 1, storageId: 'head-warehouse' }],
          correlationId,
        });

        expect(logger.warn).toHaveBeenCalledWith(
          { err, correlationId, productIds: [1], keyCount: 1 },
          'UNLINK failed during stock cache invalidation',
        );
      });

      it('falls back to named-key invalidation when client lacks scanIterator (Cluster/Sentinel)', async () => {
        cache.primary.store = makeKeyvRedisStub({ client: {} });
        cache.del.mockResolvedValue(undefined);

        await adapter.invalidate({
          items: [{ productId: 1, storageId: 'head-warehouse' }],
          correlationId,
        });

        expect(logger.warn).toHaveBeenCalledWith(
          { correlationId },
          'Redis client does not expose scanIterator; falling back to named-key invalidation',
        );
        expect(cache.del).toHaveBeenCalledWith('stock:1:*');
        expect(cache.del).toHaveBeenCalledWith('stock:1:head-warehouse');
      });
    });
  });
});
