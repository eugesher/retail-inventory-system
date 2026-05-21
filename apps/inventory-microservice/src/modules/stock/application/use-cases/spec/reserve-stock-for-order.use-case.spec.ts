import { PinoLogger } from 'nestjs-pino';

import {
  INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD,
  INVENTORY_DEFAULT_STORAGE,
  IOrderProductConfirm,
  IProductStockOrderConfirmPayload,
  OrderProductStatusEnum,
  ProductStockActionEnum,
} from '@retail-inventory-system/contracts';
import { makePinoLoggerMock, PinoLoggerMock } from '@retail-inventory-system/observability/testing';

import { StockLowEvent } from '../../../domain';
import {
  IStockCacheInvalidateItem,
  IStockCachePort,
  IStockEventsPublisherPort,
  IStockRepositoryPort,
  IStockWithInvalidationOptions,
  ITransactionPort,
  ITransactionScope,
} from '../../ports';
import { ReserveStockForOrderUseCase } from '../reserve-stock-for-order.use-case';

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

// Sentinel scope value. The repository port methods receive this and the
// spec asserts on identity — the concrete shape is irrelevant here because
// only the TypeORM adapter ever inspects an `ITransactionScope`.
const txScope = {} as ITransactionScope;

const makeTransactionPort = (): {
  transactionPort: ITransactionPort;
  runInTransaction: jest.Mock;
} => {
  const runInTransaction = jest.fn((work: (scope: ITransactionScope) => unknown) =>
    Promise.resolve(work(txScope)),
  );
  return {
    transactionPort: { runInTransaction } as unknown as ITransactionPort,
    runInTransaction,
  };
};

// Faithful in-place stand-in for the production `StockCache.withInvalidation`
// contract (ADR-023): run work first, only then derive items and call the
// `invalidatePrefixes` spy. Captures call ordering and item payloads so the
// spec can assert post-commit semantics without mocking out the helper body.
type WithInvalidationMock = jest.Mock<
  Promise<unknown>,
  [
    work: () => Promise<unknown>,
    resolveItems: (result: unknown) => IStockCacheInvalidateItem[],
    opts?: IStockWithInvalidationOptions,
  ]
>;

const makeStockCache = (
  invalidatePrefixes: jest.Mock,
): {
  stockCache: jest.Mocked<Pick<IStockCachePort, 'withInvalidation'>>;
  withInvalidation: WithInvalidationMock;
} => {
  const withInvalidation: WithInvalidationMock = jest.fn(async (work, resolveItems, opts) => {
    const result = await work();
    const items = resolveItems(result);
    if (items.length > 0) {
      await invalidatePrefixes(items, opts);
    }
    return result;
  });
  return {
    stockCache: { withInvalidation } as never,
    withInvalidation,
  };
};

describe('ReserveStockForOrderUseCase', () => {
  let repository: jest.Mocked<Pick<IStockRepositoryPort, 'lockedTotalsByProduct' | 'appendDeltas'>>;
  let stockCache: jest.Mocked<Pick<IStockCachePort, 'withInvalidation'>>;
  let withInvalidation: WithInvalidationMock;
  let invalidatePrefixes: jest.Mock;
  let publisher: { publishStockLow: jest.Mock; publishStockReserved: jest.Mock };
  let logger: PinoLoggerMock;
  let useCase: ReserveStockForOrderUseCase;
  let transactionPort: ITransactionPort;
  let runInTransaction: jest.Mock;

  beforeEach(() => {
    jest.resetAllMocks();
    repository = {
      lockedTotalsByProduct: jest.fn(),
      appendDeltas: jest.fn(),
    } as never;
    invalidatePrefixes = jest.fn().mockResolvedValue(undefined);
    ({ stockCache, withInvalidation } = makeStockCache(invalidatePrefixes));
    publisher = {
      publishStockLow: jest.fn().mockResolvedValue(undefined),
      publishStockReserved: jest.fn().mockResolvedValue(undefined),
    };
    logger = makePinoLoggerMock();
    ({ transactionPort, runInTransaction } = makeTransactionPort());
    useCase = new ReserveStockForOrderUseCase(
      transactionPort,
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
      expect(runInTransaction).not.toHaveBeenCalled();
      expect(repository.appendDeltas).not.toHaveBeenCalled();
      expect(withInvalidation).not.toHaveBeenCalled();
      expect(invalidatePrefixes).not.toHaveBeenCalled();
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

      const result = await useCase.execute(payload);

      expect(result).toEqual([11, 12]);

      // Locked totals were fetched within the transaction scope.
      expect(repository.lockedTotalsByProduct).toHaveBeenCalledWith(
        { productIds: [1, 2], correlationId },
        txScope,
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
        txScope,
      );

      // The helper was invoked once with the correlationId option flowed through.
      expect(withInvalidation).toHaveBeenCalledTimes(1);
      const opts = withInvalidation.mock.calls[0][2];
      expect(opts).toEqual({ correlationId });

      // Post-commit invalidation receives only the (productId, storageId) shape.
      expect(invalidatePrefixes).toHaveBeenCalledTimes(1);
      expect(invalidatePrefixes).toHaveBeenCalledWith(
        [
          { productId: 1, storageId: INVENTORY_DEFAULT_STORAGE },
          { productId: 2, storageId: INVENTORY_DEFAULT_STORAGE },
        ],
        { correlationId },
      );

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
      expect(invalidatePrefixes).not.toHaveBeenCalled();
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
      // The helper still fires (the transaction completes), but resolveItems
      // produces an empty list so the prefix-delete is not invoked.
      expect(withInvalidation).toHaveBeenCalledTimes(1);
      expect(invalidatePrefixes).not.toHaveBeenCalled();
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

      const result = await useCase.execute(payload);

      expect(result).toEqual([11]);

      expect(repository.appendDeltas).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [expect.objectContaining({ productId: 1, orderProductId: 11, quantity: -1 })],
        }),
        txScope,
      );
      expect(invalidatePrefixes).toHaveBeenCalledWith(
        [{ productId: 1, storageId: INVENTORY_DEFAULT_STORAGE }],
        { correlationId },
      );
    });

    it('error-logs and rethrows when the transaction rejects, and does not invalidate', async () => {
      // ADR-023 negative path: rejection inside `work` propagates through
      // `withInvalidation` without ever reaching the prefix delete. The
      // helper's contract — invalidate only on resolution — is the bumper
      // that prevents a rolled-back transaction from poisoning the cache.
      const payload: IProductStockOrderConfirmPayload = {
        products: [pendingProduct(11, 1)],
        correlationId,
      };
      const err = new Error('tx-fail');
      runInTransaction.mockRejectedValue(err);

      await expect(useCase.execute(payload)).rejects.toBe(err);

      expect(logger.error).toHaveBeenCalledWith(
        { err, correlationId, productIds: [1], pendingCount: 1 },
        'Error reserving stock for order products',
      );
      expect(withInvalidation).toHaveBeenCalledTimes(1);
      expect(invalidatePrefixes).not.toHaveBeenCalled();
      expect(publisher.publishStockLow).not.toHaveBeenCalled();
    });

    it('runs appendDeltas (in-transaction) before invalidatePrefixes (post-commit)', async () => {
      // ADR-023 positive path: the helper's body intrinsically orders
      // `work` resolution before the prefix delete, so we can assert the
      // invocation order at the spy level without relying on any
      // transaction-callback shape.
      const high = INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD + 10;
      const payload: IProductStockOrderConfirmPayload = {
        products: [pendingProduct(11, 1)],
        correlationId,
      };
      repository.lockedTotalsByProduct.mockResolvedValue(new Map([[1, high]]));
      repository.appendDeltas.mockResolvedValue(undefined);

      await useCase.execute(payload);

      const appendOrder = repository.appendDeltas.mock.invocationCallOrder[0];
      const invalidateOrder = invalidatePrefixes.mock.invocationCallOrder[0];
      expect(appendOrder).toBeLessThan(invalidateOrder);
    });

    it('does not invoke invalidatePrefixes when work rejects after partial appendDeltas', async () => {
      // ADR-023: even if the inner work has done some I/O, a rejection
      // means no invalidate. Simulated by letting appendDeltas resolve but
      // failing the transaction commit afterwards.
      const high = INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD + 10;
      const payload: IProductStockOrderConfirmPayload = {
        products: [pendingProduct(11, 1)],
        correlationId,
      };
      repository.lockedTotalsByProduct.mockResolvedValue(new Map([[1, high]]));
      repository.appendDeltas.mockResolvedValue(undefined);
      const commitErr = new Error('commit-fail');
      // Override the transaction port to invoke the inner callback (so
      // appendDeltas runs) and then reject as if the commit failed.
      runInTransaction.mockImplementationOnce(
        async (callback: (scope: ITransactionScope) => unknown) => {
          await callback(txScope);
          throw commitErr;
        },
      );

      await expect(useCase.execute(payload)).rejects.toBe(commitErr);

      expect(repository.appendDeltas).toHaveBeenCalledTimes(1);
      expect(invalidatePrefixes).not.toHaveBeenCalled();
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
