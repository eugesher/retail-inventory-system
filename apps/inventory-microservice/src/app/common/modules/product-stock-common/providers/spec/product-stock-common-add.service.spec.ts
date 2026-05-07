import { PinoLogger } from 'nestjs-pino';
import { EntityManager, Repository } from 'typeorm';

import { ProductStock } from '../../../../entities';
import { IProductStockCommonAddItem } from '../../interfaces';
import { ProductStockCommonAddService } from '../product-stock-common-add.service';

const correlationId = 'corr-1';
const items: IProductStockCommonAddItem[] = [
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

describe('ProductStockCommonAddService', () => {
  let injectedRepo: jest.Mocked<Pick<Repository<ProductStock>, 'insert'>>;
  let logger: LoggerMock;
  let service: ProductStockCommonAddService;

  beforeEach(() => {
    jest.resetAllMocks();
    injectedRepo = { insert: jest.fn() } as never;
    logger = makeLogger();
    service = new ProductStockCommonAddService(
      injectedRepo as unknown as Repository<ProductStock>,
      logger as unknown as PinoLogger,
    );
  });

  describe('execute', () => {
    it('inserts via the injected repository when no entity manager is provided', async () => {
      injectedRepo.insert.mockResolvedValue(undefined as never);

      await service.execute({ items, correlationId });

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

      await service.execute({ items, correlationId }, entityManager);

      expect(getRepository).toHaveBeenCalledWith(ProductStock);
      expect(txRepo.insert).toHaveBeenCalledWith(items);
      expect(injectedRepo.insert).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        { correlationId, itemCount: 2, withinTransaction: true },
        'Inserting product stock ledger rows',
      );
    });

    it('error-logs and rethrows when the insert rejects', async () => {
      const err = new Error('insert-fail');
      injectedRepo.insert.mockRejectedValue(err);

      await expect(service.execute({ items, correlationId })).rejects.toBe(err);

      expect(logger.error).toHaveBeenCalledWith(
        { err, correlationId, itemCount: 2 },
        'Failed to insert product stock ledger rows',
      );
      // The success info log must not fire on the error path.
      expect(logger.info).not.toHaveBeenCalled();
    });
  });
});
