import { PinoLogger } from 'nestjs-pino';
import { EntityManager, Repository } from 'typeorm';

import { ProductStock } from '../product-stock.entity';
import { StockTypeormRepository } from '../stock-typeorm.repository';

const correlationId = 'corr-1';

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
  for (const key of ['select', 'where', 'andWhere', 'groupBy', 'addSelect', 'setLock']) {
    qb[key].mockReturnValue(qb);
  }
  return qb;
};

describe('StockTypeormRepository', () => {
  let injectedRepo: jest.Mocked<
    Pick<Repository<ProductStock>, 'createQueryBuilder' | 'insert' | 'findOne' | 'save'>
  >;
  let logger: LoggerMock;
  let repository: StockTypeormRepository;

  beforeEach(() => {
    jest.resetAllMocks();
    injectedRepo = {
      createQueryBuilder: jest.fn(),
      insert: jest.fn(),
      findOne: jest.fn(),
      save: jest.fn(),
    } as never;
    logger = makeLogger();
    repository = new StockTypeormRepository(
      injectedRepo as unknown as Repository<ProductStock>,
      logger as unknown as PinoLogger,
    );
  });

  describe('aggregateForProduct', () => {
    it('aggregates rows by storage and returns the max updatedAt', async () => {
      const date1 = new Date('2024-01-01');
      const date2 = new Date('2024-02-01');
      const rawMany = jest.fn().mockResolvedValue([
        { storageId: 'a', quantity: '3', updatedAt: date1 },
        { storageId: 'b', quantity: '4', updatedAt: date2 },
      ]);
      const qb = makeQueryBuilder(rawMany);
      injectedRepo.createQueryBuilder.mockReturnValue(qb as never);

      const result = await repository.aggregateForProduct({ productId: 1, correlationId });

      expect(result).toEqual({
        productId: 1,
        quantity: 7,
        updatedAt: date2,
        items: [
          { storageId: 'a', quantity: 3, updatedAt: date1 },
          { storageId: 'b', quantity: 4, updatedAt: date2 },
        ],
      });
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

      await repository.aggregateForProduct({
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

      await repository.aggregateForProduct({ productId: 1, correlationId }, entityManager);

      expect(getRepository).toHaveBeenCalledWith(ProductStock);
      expect(txRepo.createQueryBuilder).toHaveBeenCalled();
      expect(injectedRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('returns zero quantity and null updatedAt for an empty result set', async () => {
      const rawMany = jest.fn().mockResolvedValue([]);
      const qb = makeQueryBuilder(rawMany);
      injectedRepo.createQueryBuilder.mockReturnValue(qb as never);

      const result = await repository.aggregateForProduct({ productId: 99, correlationId });

      expect(result).toEqual({ productId: 99, quantity: 0, updatedAt: null, items: [] });
    });

    it('error-logs and rethrows when getRawMany rejects', async () => {
      const err = new Error('db-fail');
      const rawMany = jest.fn().mockRejectedValue(err);
      const qb = makeQueryBuilder(rawMany);
      injectedRepo.createQueryBuilder.mockReturnValue(qb as never);

      await expect(repository.aggregateForProduct({ productId: 1, correlationId })).rejects.toBe(
        err,
      );

      expect(logger.error).toHaveBeenCalledWith(
        { err, correlationId, productId: 1, storageIds: undefined },
        'Failed to aggregate product stock by storage',
      );
    });
  });

  describe('lockedTotalsByProduct', () => {
    it('returns an empty Map without touching the database when productIds is empty', async () => {
      const createQueryBuilder = jest.fn();
      const entityManager = { createQueryBuilder } as unknown as EntityManager;

      const result = await repository.lockedTotalsByProduct(
        { productIds: [], correlationId },
        entityManager,
      );

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

      const result = await repository.lockedTotalsByProduct(
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
        repository.lockedTotalsByProduct({ productIds: [1], correlationId }, entityManager),
      ).rejects.toBe(err);

      expect(logger.error).toHaveBeenCalledWith(
        { err, correlationId, productIds: [1] },
        'Failed to load locked stock totals',
      );
    });
  });

  describe('appendDeltas', () => {
    const items = [
      {
        productId: 1,
        storageId: 'head-warehouse',
        actionId: 'order-product-confirm',
        quantity: -1,
        orderProductId: 11,
      },
      {
        productId: 2,
        storageId: 'head-warehouse',
        actionId: 'order-product-confirm',
        quantity: -1,
        orderProductId: 12,
      },
    ];

    it('inserts via the injected repository when no entity manager is provided', async () => {
      injectedRepo.insert.mockResolvedValue(undefined as never);

      await repository.appendDeltas({ items, correlationId });

      expect(injectedRepo.insert).toHaveBeenCalledWith(items);
      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, itemCount: 2, withinTransaction: false },
        'Inserting product stock ledger rows',
      );
      expect(logger.info).toHaveBeenCalledWith(
        { correlationId, itemCount: 2, productIds: [1, 2] },
        'Product stock ledger rows inserted',
      );
    });

    it('inserts via the entity-manager repository when one is provided', async () => {
      const txRepo = { insert: jest.fn().mockResolvedValue(undefined) };
      const getRepository = jest.fn().mockReturnValue(txRepo);
      const entityManager = { getRepository } as unknown as EntityManager;

      await repository.appendDeltas({ items, correlationId }, entityManager);

      expect(getRepository).toHaveBeenCalledWith(ProductStock);
      expect(txRepo.insert).toHaveBeenCalledWith(items);
      expect(injectedRepo.insert).not.toHaveBeenCalled();
    });

    it('error-logs and rethrows when the insert rejects', async () => {
      const err = new Error('insert-fail');
      injectedRepo.insert.mockRejectedValue(err);

      await expect(repository.appendDeltas({ items, correlationId })).rejects.toBe(err);

      expect(logger.error).toHaveBeenCalledWith(
        { err, correlationId, itemCount: 2 },
        'Failed to insert product stock ledger rows',
      );
      expect(logger.info).not.toHaveBeenCalled();
    });
  });
});
