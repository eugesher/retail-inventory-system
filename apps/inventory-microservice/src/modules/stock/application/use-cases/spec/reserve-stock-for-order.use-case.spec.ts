import { PinoLogger } from 'nestjs-pino';
import { EntityManager } from 'typeorm';

import {
  INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD,
  INVENTORY_DEFAULT_STORAGE,
  IOrderProductConfirm,
  IProductStockOrderConfirmPayload,
  OrderProductStatusEnum,
  ProductStockActionEnum,
} from '@retail-inventory-system/contracts';

import { StockLowEvent } from '../../../domain';
import { IStockCachePort, IStockEventsPublisherPort, IStockRepositoryPort } from '../../ports';
import { ReserveStockForOrderUseCase } from '../reserve-stock-for-order.use-case';

type LoggerMock = Record<'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'trace', jest.Mock>;

const makeLogger = (): LoggerMock => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  fatal: jest.fn(),
  trace: jest.fn(),
});

const correlationId = 'corr-1';

const pendingProduct = (id: number, productId: number): IOrderProductConfirm => ({
  id,
  productId,
  statusId: OrderProductStatusEnum.PENDING,
});

const confirmedProduct = (id: number, productId: number): IOrderProductConfirm => ({
  id,
  productId,
  statusId: OrderProductStatusEnum.CONFIRMED,
});

const txEm = {} as EntityManager;

const makeEntityManager = (): { entityManager: EntityManager; transaction: jest.Mock } => {
  const transaction = jest.fn(async (callback: (em: EntityManager) => unknown) => {
    await callback(txEm);
  });
  return { entityManager: { transaction } as unknown as EntityManager, transaction };
};

describe('ReserveStockForOrderUseCase', () => {
  let repository: jest.Mocked<Pick<IStockRepositoryPort, 'lockedTotalsByProduct' | 'appendDeltas'>>;
  let stockCache: jest.Mocked<Pick<IStockCachePort, 'invalidate'>>;
  let publisher: { publishStockLow: jest.Mock; publishStockReserved: jest.Mock };
  let logger: LoggerMock;
  let useCase: ReserveStockForOrderUseCase;
  let entityManager: EntityManager;
  let transaction: jest.Mock;

  beforeEach(() => {
    jest.resetAllMocks();
    repository = {
      lockedTotalsByProduct: jest.fn(),
      appendDeltas: jest.fn(),
    } as never;
    stockCache = { invalidate: jest.fn() } as never;
    publisher = {
      publishStockLow: jest.fn().mockResolvedValue(undefined),
      publishStockReserved: jest.fn().mockResolvedValue(undefined),
    };
    logger = makeLogger();
    ({ entityManager, transaction } = makeEntityManager());
    useCase = new ReserveStockForOrderUseCase(
      entityManager,
      repository as unknown as IStockRepositoryPort,
      stockCache as unknown as IStockCachePort,
      publisher as unknown as IStockEventsPublisherPort,
      logger as unknown as PinoLogger,
    );
  });

  describe('execute', () => {
    it('returns [] without opening a transaction when no products are pending', async () => {
      const payload: IProductStockOrderConfirmPayload = {
        products: [confirmedProduct(1, 1), confirmedProduct(2, 1)],
        correlationId,
      };

      const result = await useCase.execute(payload);

      expect(result).toEqual([]);
      expect(transaction).not.toHaveBeenCalled();
      expect(repository.appendDeltas).not.toHaveBeenCalled();
      expect(stockCache.invalidate).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        { correlationId },
        'No pending products to reserve stock for',
      );
    });

    it('confirms every pending product when stock is sufficient and invalidates cache post-commit', async () => {
      const payload: IProductStockOrderConfirmPayload = {
        products: [pendingProduct(11, 1), pendingProduct(12, 2)],
        correlationId,
      };
      // Quantities well above the low-stock threshold so no `stock.low` is emitted.
      const high = INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD + 10;
      repository.lockedTotalsByProduct.mockResolvedValue(
        new Map([
          [1, high],
          [2, high],
        ]),
      );
      repository.appendDeltas.mockResolvedValue(undefined);
      stockCache.invalidate.mockResolvedValue(undefined);

      const result = await useCase.execute(payload);

      expect(result).toEqual([11, 12]);

      // Locked totals were fetched within the transaction.
      expect(repository.lockedTotalsByProduct).toHaveBeenCalledWith(
        { productIds: [1, 2], correlationId },
        txEm,
      );

      // appendDeltas received exactly one ledger row per pending product.
      expect(repository.appendDeltas).toHaveBeenCalledTimes(1);
      expect(repository.appendDeltas).toHaveBeenCalledWith(
        {
          items: [
            {
              productId: 1,
              storageId: INVENTORY_DEFAULT_STORAGE,
              actionId: ProductStockActionEnum.ORDER_PRODUCT_CONFIRM,
              quantity: -1,
              orderProductId: 11,
            },
            {
              productId: 2,
              storageId: INVENTORY_DEFAULT_STORAGE,
              actionId: ProductStockActionEnum.ORDER_PRODUCT_CONFIRM,
              quantity: -1,
              orderProductId: 12,
            },
          ],
          correlationId,
        },
        txEm,
      );

      // Post-commit invalidation receives only the (productId, storageId) shape.
      expect(stockCache.invalidate).toHaveBeenCalledWith({
        items: [
          { productId: 1, storageId: INVENTORY_DEFAULT_STORAGE },
          { productId: 2, storageId: INVENTORY_DEFAULT_STORAGE },
        ],
        correlationId,
      });

      expect(publisher.publishStockLow).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith(
        { correlationId, confirmedCount: 2, skippedCount: 0 },
        'Stock reserved for order products',
      );
    });

    it('treats a missing stockMap entry as zero available (?? 0 branch)', async () => {
      const payload: IProductStockOrderConfirmPayload = {
        products: [pendingProduct(11, 1)],
        correlationId,
      };
      repository.lockedTotalsByProduct.mockResolvedValue(new Map());

      const result = await useCase.execute(payload);

      expect(result).toEqual([]);
      expect(repository.appendDeltas).not.toHaveBeenCalled();
      expect(stockCache.invalidate).not.toHaveBeenCalled();
    });

    it('skips append and invalidate and warn-logs when no product has available stock', async () => {
      const payload: IProductStockOrderConfirmPayload = {
        products: [pendingProduct(11, 1)],
        correlationId,
      };
      repository.lockedTotalsByProduct.mockResolvedValue(new Map([[1, 0]]));

      const result = await useCase.execute(payload);

      expect(result).toEqual([]);
      expect(repository.appendDeltas).not.toHaveBeenCalled();
      expect(stockCache.invalidate).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        { correlationId, pendingCount: 1, productIds: [1] },
        'No stock available to reserve for any pending order products',
      );
    });

    it('confirms only the products with available stock and invalidates only their cache', async () => {
      const payload: IProductStockOrderConfirmPayload = {
        products: [
          pendingProduct(11, 1),
          pendingProduct(12, 1),
          pendingProduct(13, 2), // product 2 has no stock
        ],
        correlationId,
      };
      repository.lockedTotalsByProduct.mockResolvedValue(
        new Map([
          [1, 1],
          [2, 0],
        ]),
      );
      repository.appendDeltas.mockResolvedValue(undefined);
      stockCache.invalidate.mockResolvedValue(undefined);

      const result = await useCase.execute(payload);

      expect(result).toEqual([11]);

      expect(repository.appendDeltas).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [expect.objectContaining({ productId: 1, orderProductId: 11, quantity: -1 })],
        }),
        txEm,
      );
      expect(stockCache.invalidate).toHaveBeenCalledWith({
        items: [{ productId: 1, storageId: INVENTORY_DEFAULT_STORAGE }],
        correlationId,
      });
    });

    it('error-logs and rethrows when the transaction rejects, and does not invalidate', async () => {
      const payload: IProductStockOrderConfirmPayload = {
        products: [pendingProduct(11, 1)],
        correlationId,
      };
      const err = new Error('tx-fail');
      transaction.mockRejectedValue(err);

      await expect(useCase.execute(payload)).rejects.toBe(err);

      expect(logger.error).toHaveBeenCalledWith(
        { err, correlationId, productIds: [1], pendingCount: 1 },
        'Error reserving stock for order products',
      );
      expect(stockCache.invalidate).not.toHaveBeenCalled();
      expect(publisher.publishStockLow).not.toHaveBeenCalled();
    });

    it('orders appendDeltas (in-transaction) before invalidate (post-commit)', async () => {
      const high = INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD + 10;
      const payload: IProductStockOrderConfirmPayload = {
        products: [pendingProduct(11, 1)],
        correlationId,
      };
      repository.lockedTotalsByProduct.mockResolvedValue(new Map([[1, high]]));
      repository.appendDeltas.mockResolvedValue(undefined);
      stockCache.invalidate.mockResolvedValue(undefined);

      await useCase.execute(payload);

      const appendOrder = repository.appendDeltas.mock.invocationCallOrder[0];
      const invalidateOrder = stockCache.invalidate.mock.invocationCallOrder[0];
      expect(appendOrder).toBeLessThan(invalidateOrder);
    });

    it('emits inventory.stock.low when the post-commit quantity sits at-or-below the threshold', async () => {
      // Single pending product on a stock of (threshold + 1). After one
      // reservation of -1, the post-commit quantity equals the threshold,
      // which fires the event.
      const startingQty = INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD + 1;
      const payload: IProductStockOrderConfirmPayload = {
        products: [pendingProduct(11, 1)],
        correlationId,
      };
      repository.lockedTotalsByProduct.mockResolvedValue(new Map([[1, startingQty]]));
      repository.appendDeltas.mockResolvedValue(undefined);
      stockCache.invalidate.mockResolvedValue(undefined);

      await useCase.execute(payload);

      expect(publisher.publishStockLow).toHaveBeenCalledTimes(1);
      const [emittedEvent, emittedCorrelation] = publisher.publishStockLow.mock.calls[0] as [
        StockLowEvent,
        string | undefined,
      ];
      expect(emittedEvent.aggregateId).toBe(1);
      expect(emittedEvent.storageId).toBe(INVENTORY_DEFAULT_STORAGE);
      expect(emittedEvent.quantity).toBe(INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD);
      expect(emittedEvent.threshold).toBe(INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD);
      expect(emittedCorrelation).toBe(correlationId);
    });
  });
});
