import { PinoLogger } from 'nestjs-pino';
import { EntityManager, Repository } from 'typeorm';

import { ProductStock } from '../../../../entities';
import { IProductStockCommonGetRawResult } from '../../interfaces';
import { ProductStockCommonGetService } from '../product-stock-common-get.service';

const correlationId = 'corr-1';

// LoggerMock factory duplication: this LoggerMock type + makeLogger factory
// is duplicated across all six inventory-microservice product-stock specs and
// should be hoisted into a shared spec-helper. See
// product-stock-common-cache.service.spec.ts header for the full convention
// rationale.
type LoggerMock = Record<'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'trace', jest.Mock>;

const makeLogger = (): LoggerMock => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
  trace: jest.fn(),
});

const makeQueryBuilder = (rawMany: jest.Mock): Record<string, jest.Mock> => {
  const qb: Record<string, jest.Mock> = {
    select: jest.fn(),
    where: jest.fn(),
    andWhere: jest.fn(),
    groupBy: jest.fn(),
    addSelect: jest.fn(),
    setLock: jest.fn(),
    getRawMany: rawMany,
  };
  // Each chainable method returns the builder.
  for (const key of ['select', 'where', 'andWhere', 'groupBy', 'addSelect', 'setLock']) {
    qb[key].mockReturnValue(qb);
  }
  return qb;
};

describe('ProductStockCommonGetService', () => {
  let injectedRepo: jest.Mocked<Pick<Repository<ProductStock>, 'createQueryBuilder'>>;
  let logger: LoggerMock;
  let service: ProductStockCommonGetService;

  beforeEach(() => {
    jest.resetAllMocks();
    injectedRepo = { createQueryBuilder: jest.fn() } as never;
    logger = makeLogger();
    service = new ProductStockCommonGetService(
      injectedRepo as unknown as Repository<ProductStock>,
      logger as unknown as PinoLogger,
    );
  });

  describe('execute', () => {
    it('aggregates rows by storage and returns the max updatedAt', async () => {
      const date1 = new Date('2024-01-01');
      const date2 = new Date('2024-02-01');
      const rawMany = jest.fn().mockResolvedValue([
        { storageId: 'a', quantity: '3', updatedAt: date1 },
        { storageId: 'b', quantity: '4', updatedAt: date2 },
      ] satisfies IProductStockCommonGetRawResult[]);
      const qb = makeQueryBuilder(rawMany);
      injectedRepo.createQueryBuilder.mockReturnValue(qb as never);

      const result = await service.execute({ productId: 1, correlationId });

      expect(result).toEqual({
        productId: 1,
        quantity: 7,
        updatedAt: date2,
        items: [
          { storageId: 'a', quantity: 3, updatedAt: date1 },
          { storageId: 'b', quantity: 4, updatedAt: date2 },
        ],
      });
      // No storageIds → andWhere is not invoked.
      expect(qb.andWhere).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, productId: 1, rowCount: 2 },
        'Stock rows retrieved from DB',
      );
    });

    it('adds the storageIds filter when provided', async () => {
      const rawMany = jest.fn().mockResolvedValue([]);
      const qb = makeQueryBuilder(rawMany);
      injectedRepo.createQueryBuilder.mockReturnValue(qb as never);

      await service.execute({
        productId: 1,
        storageIds: ['head-warehouse'],
        correlationId,
      });

      expect(qb.andWhere).toHaveBeenCalledWith('ProductStock.storageId IN (:...storageIds)', {
        storageIds: ['head-warehouse'],
      });
    });

    it('uses the entity-manager repository when one is provided', async () => {
      const rawMany = jest.fn().mockResolvedValue([]);
      const qb = makeQueryBuilder(rawMany);
      const txRepo = { createQueryBuilder: jest.fn().mockReturnValue(qb) };
      const getRepository = jest.fn().mockReturnValue(txRepo);
      const entityManager = { getRepository } as unknown as EntityManager;

      await service.execute({ productId: 1, correlationId }, entityManager);

      expect(getRepository).toHaveBeenCalledWith(ProductStock);
      expect(txRepo.createQueryBuilder).toHaveBeenCalled();
      expect(injectedRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('returns zero quantity and null updatedAt for an empty result set', async () => {
      const rawMany = jest.fn().mockResolvedValue([]);
      const qb = makeQueryBuilder(rawMany);
      injectedRepo.createQueryBuilder.mockReturnValue(qb as never);

      const result = await service.execute({ productId: 99, correlationId });

      expect(result).toEqual({ productId: 99, quantity: 0, updatedAt: null, items: [] });
    });

    it('error-logs and rethrows when getRawMany rejects', async () => {
      const err = new Error('db-fail');
      const rawMany = jest.fn().mockRejectedValue(err);
      const qb = makeQueryBuilder(rawMany);
      injectedRepo.createQueryBuilder.mockReturnValue(qb as never);

      await expect(service.execute({ productId: 1, correlationId })).rejects.toBe(err);

      expect(logger.error).toHaveBeenCalledWith(
        { err, correlationId, productId: 1, storageIds: undefined },
        'Failed to aggregate product stock by storage',
      );
    });
  });

  describe('getMapLocked', () => {
    it('returns an empty Map without touching the database when productIds is empty', async () => {
      const createQueryBuilder = jest.fn();
      const entityManager = { createQueryBuilder } as unknown as EntityManager;

      const result = await service.getMapLocked({ productIds: [], correlationId }, entityManager);

      expect(result.size).toBe(0);
      expect(createQueryBuilder).not.toHaveBeenCalled();
    });

    it('issues a pessimistic_write-locked aggregate and returns a productId→quantity Map', async () => {
      const rawMany = jest.fn().mockResolvedValue([
        { productId: '1', totalQuantity: '5' },
        { productId: '2', totalQuantity: '3' },
      ]);
      const qb = makeQueryBuilder(rawMany);
      const entityManager = {
        createQueryBuilder: jest.fn().mockReturnValue(qb),
      } as unknown as EntityManager;

      const result = await service.getMapLocked(
        { productIds: [1, 2], correlationId },
        entityManager,
      );

      expect(qb.setLock).toHaveBeenCalledWith('pessimistic_write');
      expect(result.get(1)).toBe(5);
      expect(result.get(2)).toBe(3);
      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, productIds: [1, 2], balanceCount: 2 },
        'Locked stock totals loaded from DB',
      );
    });

    it('error-logs and rethrows when the locked query rejects', async () => {
      const err = new Error('lock-fail');
      const rawMany = jest.fn().mockRejectedValue(err);
      const qb = makeQueryBuilder(rawMany);
      const entityManager = {
        createQueryBuilder: jest.fn().mockReturnValue(qb),
      } as unknown as EntityManager;

      await expect(
        service.getMapLocked({ productIds: [1], correlationId }, entityManager),
      ).rejects.toBe(err);

      expect(logger.error).toHaveBeenCalledWith(
        { err, correlationId, productIds: [1] },
        'Failed to load locked stock totals',
      );
    });
  });
});
