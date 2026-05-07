import { PinoLogger } from 'nestjs-pino';
import { EntityManager } from 'typeorm';

import { ProductStockGetResponseDto } from '@retail-inventory-system/inventory';
import {
  ProductStockCommonAddService,
  ProductStockCommonCacheService,
  ProductStockCommonGetService,
} from '../providers';
import { ProductStockCommonService } from '../product-stock-common.service';

const correlationId = 'corr-1';
const sampleDto: ProductStockGetResponseDto = {
  productId: 1,
  quantity: 5,
  updatedAt: null,
  items: [],
};

// FU17 / FU18: this LoggerMock type + makeLogger factory is duplicated across
// all six inventory-microservice product-stock specs and should be hoisted into
// a shared spec-helper. See product-stock-common-cache.service.spec.ts header
// for the full convention rationale and follow-up details.
type LoggerMock = Record<'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'trace', jest.Mock>;

const makeLogger = (): LoggerMock => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
  trace: jest.fn(),
});

describe('ProductStockCommonService', () => {
  let addService: jest.Mocked<Pick<ProductStockCommonAddService, 'execute'>>;
  let getService: jest.Mocked<Pick<ProductStockCommonGetService, 'execute' | 'getMapLocked'>>;
  let cacheService: jest.Mocked<Pick<ProductStockCommonCacheService, 'get' | 'set' | 'invalidate'>>;
  let logger: LoggerMock;
  let service: ProductStockCommonService;

  beforeEach(() => {
    jest.resetAllMocks();
    addService = { execute: jest.fn() } as never;
    getService = { execute: jest.fn(), getMapLocked: jest.fn() } as never;
    cacheService = { get: jest.fn(), set: jest.fn(), invalidate: jest.fn() } as never;
    logger = makeLogger();
    service = new ProductStockCommonService(
      addService as unknown as ProductStockCommonAddService,
      getService as unknown as ProductStockCommonGetService,
      cacheService as unknown as ProductStockCommonCacheService,
      logger as unknown as PinoLogger,
    );
  });

  describe('add', () => {
    it('delegates to the add service without an entity manager and debug-logs withinTransaction:false', async () => {
      addService.execute.mockResolvedValue(undefined);

      await service.add({ items: [], correlationId });

      expect(addService.execute).toHaveBeenCalledWith({ items: [], correlationId }, undefined);
      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, itemCount: 0, withinTransaction: false },
        'Delegating to ProductStockCommonAddService',
      );
    });

    it('passes the entity manager through and debug-logs withinTransaction:true', async () => {
      const em = {} as EntityManager;
      addService.execute.mockResolvedValue(undefined);

      await service.add({ items: [], correlationId }, em);

      expect(addService.execute).toHaveBeenCalledWith({ items: [], correlationId }, em);
      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, itemCount: 0, withinTransaction: true },
        'Delegating to ProductStockCommonAddService',
      );
    });
  });

  describe('get', () => {
    it('returns the cached DTO without consulting the DB on cache hit', async () => {
      cacheService.get.mockResolvedValue(sampleDto);

      const result = await service.get({ productId: 1, correlationId });

      expect(result).toBe(sampleDto);
      expect(cacheService.get).toHaveBeenCalledWith({
        productId: 1,
        storageIds: undefined,
        correlationId,
      });
      expect(getService.execute).not.toHaveBeenCalled();
      expect(cacheService.set).not.toHaveBeenCalled();
    });

    it('falls through to the DB on cache miss and writes the result back', async () => {
      cacheService.get.mockResolvedValue(undefined);
      getService.execute.mockResolvedValue(sampleDto);

      const result = await service.get({ productId: 1, correlationId });

      expect(result).toBe(sampleDto);
      expect(getService.execute).toHaveBeenCalledWith({ productId: 1, correlationId }, undefined);
      expect(cacheService.set).toHaveBeenCalledWith({
        productId: 1,
        storageIds: undefined,
        data: sampleDto,
        correlationId,
      });
    });

    it('rethrows DB errors on cache miss and does not write to cache', async () => {
      const err = new Error('db-fail');
      cacheService.get.mockResolvedValue(undefined);
      getService.execute.mockRejectedValue(err);

      await expect(service.get({ productId: 1, correlationId })).rejects.toBe(err);
      expect(cacheService.set).not.toHaveBeenCalled();
    });

    it('skips both cache read and write when an entity manager is provided', async () => {
      const em = {} as EntityManager;
      getService.execute.mockResolvedValue(sampleDto);

      await service.get({ productId: 1, correlationId }, { entityManager: em });

      expect(cacheService.get).not.toHaveBeenCalled();
      expect(cacheService.set).not.toHaveBeenCalled();
      expect(getService.execute).toHaveBeenCalledWith({ productId: 1, correlationId }, em);
      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, productId: 1, reason: 'entityManager' },
        'Cache skipped for stock query',
      );
    });

    it('skips both cache read and write when ignoreCache is true', async () => {
      getService.execute.mockResolvedValue(sampleDto);

      await service.get({ productId: 1, correlationId }, { ignoreCache: true });

      expect(cacheService.get).not.toHaveBeenCalled();
      expect(cacheService.set).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, productId: 1, reason: 'ignoreCache' },
        'Cache skipped for stock query',
      );
    });

    it('prefers reason:entityManager when both options are set', async () => {
      const em = {} as EntityManager;
      getService.execute.mockResolvedValue(sampleDto);

      await service.get({ productId: 1, correlationId }, { entityManager: em, ignoreCache: true });

      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, productId: 1, reason: 'entityManager' },
        'Cache skipped for stock query',
      );
    });

    it('orders cache.get → getService.execute → cache.set on the miss path', async () => {
      cacheService.get.mockResolvedValue(undefined);
      getService.execute.mockResolvedValue(sampleDto);
      cacheService.set.mockResolvedValue(undefined);

      await service.get({ productId: 1, correlationId });

      const getOrder = cacheService.get.mock.invocationCallOrder[0];
      const dbOrder = getService.execute.mock.invocationCallOrder[0];
      const setOrder = cacheService.set.mock.invocationCallOrder[0];
      expect(getOrder).toBeLessThan(dbOrder);
      expect(dbOrder).toBeLessThan(setOrder);
    });
  });

  describe('getMapLocked', () => {
    it('delegates to the get service with the entity manager', async () => {
      const em = {} as EntityManager;
      const map = new Map<number, number>([[1, 5]]);
      getService.getMapLocked.mockResolvedValue(map);

      const result = await service.getMapLocked({ productIds: [1], correlationId }, em);

      expect(result).toBe(map);
      expect(getService.getMapLocked).toHaveBeenCalledWith({ productIds: [1], correlationId }, em);
    });
  });

  describe('invalidate', () => {
    it('delegates to the cache service and debug-logs the delegation', async () => {
      cacheService.invalidate.mockResolvedValue(undefined);
      const payload = {
        items: [{ productId: 1, storageId: 'head-warehouse' }],
        correlationId,
      };

      await service.invalidate(payload);

      expect(cacheService.invalidate).toHaveBeenCalledWith(payload);
      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, itemCount: 1 },
        'Delegating to ProductStockCommonCacheService.invalidate',
      );
    });
  });
});
