import { PinoLogger } from 'nestjs-pino';
import { EntityManager } from 'typeorm';

import {
  INVENTORY_DEFAULT_STORAGE,
  IProductStockOrderConfirmPayload,
  ProductStockActionEnum,
} from '@retail-inventory-system/inventory';
import { IOrderProductConfirm, OrderProductStatusEnum } from '@retail-inventory-system/retail';
import { ProductStockCommonService } from '../../../../common/modules';
import { ProductStockOrderConfirmService } from '../product-stock-order-confirm.service';

const correlationId = 'corr-1';

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

describe('ProductStockOrderConfirmService', () => {
  let commonService: jest.Mocked<
    Pick<ProductStockCommonService, 'add' | 'getMapLocked' | 'invalidate'>
  >;
  let logger: LoggerMock;
  let service: ProductStockOrderConfirmService;
  let entityManager: EntityManager;
  let transaction: jest.Mock;

  beforeEach(() => {
    jest.resetAllMocks();
    commonService = {
      add: jest.fn(),
      getMapLocked: jest.fn(),
      invalidate: jest.fn(),
    } as never;
    logger = makeLogger();
    ({ entityManager, transaction } = makeEntityManager());
    service = new ProductStockOrderConfirmService(
      entityManager,
      commonService as unknown as ProductStockCommonService,
      logger as unknown as PinoLogger,
    );
  });

  describe('execute', () => {
    it('returns [] without opening a transaction when no products are pending', async () => {
      const payload: IProductStockOrderConfirmPayload = {
        products: [confirmedProduct(1, 1), confirmedProduct(2, 1)],
        correlationId,
      };

      const result = await service.execute(payload);

      expect(result).toEqual([]);
      expect(transaction).not.toHaveBeenCalled();
      expect(commonService.add).not.toHaveBeenCalled();
      expect(commonService.invalidate).not.toHaveBeenCalled();
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
      commonService.getMapLocked.mockResolvedValue(
        new Map([
          [1, 5],
          [2, 3],
        ]),
      );
      commonService.add.mockResolvedValue(undefined);
      commonService.invalidate.mockResolvedValue(undefined);

      const result = await service.execute(payload);

      expect(result).toEqual([11, 12]);

      // Locked totals were fetched within the transaction.
      expect(commonService.getMapLocked).toHaveBeenCalledWith(
        { productIds: [1, 2], correlationId },
        txEm,
      );

      // add() received exactly one ledger row per pending product, all targeting
      // the default storage with quantity -1 and the confirm action.
      expect(commonService.add).toHaveBeenCalledTimes(1);
      expect(commonService.add).toHaveBeenCalledWith(
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
      expect(commonService.invalidate).toHaveBeenCalledWith({
        items: [
          { productId: 1, storageId: INVENTORY_DEFAULT_STORAGE },
          { productId: 2, storageId: INVENTORY_DEFAULT_STORAGE },
        ],
        correlationId,
      });

      expect(logger.info).toHaveBeenCalledWith(
        { correlationId, confirmedCount: 2, skippedCount: 0 },
        'Stock reserved for order products',
      );
    });

    it('treats a missing stockMap entry as zero available (?? 0 branch)', async () => {
      // pendingItems references productId 1, but the locked-stock query returned
      // no row for it (e.g. the product has no ledger entries at all). Map.get
      // yields undefined and the ?? 0 fallback should classify it as no-stock.
      const payload: IProductStockOrderConfirmPayload = {
        products: [pendingProduct(11, 1)],
        correlationId,
      };
      commonService.getMapLocked.mockResolvedValue(new Map());

      const result = await service.execute(payload);

      expect(result).toEqual([]);
      expect(commonService.add).not.toHaveBeenCalled();
      expect(commonService.invalidate).not.toHaveBeenCalled();
    });

    it('skips add and invalidate and warn-logs when no product has available stock', async () => {
      const payload: IProductStockOrderConfirmPayload = {
        products: [pendingProduct(11, 1)],
        correlationId,
      };
      commonService.getMapLocked.mockResolvedValue(new Map([[1, 0]]));

      const result = await service.execute(payload);

      expect(result).toEqual([]);
      expect(commonService.add).not.toHaveBeenCalled();
      expect(commonService.invalidate).not.toHaveBeenCalled();
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
      commonService.getMapLocked.mockResolvedValue(
        new Map([
          [1, 1],
          [2, 0],
        ]),
      );
      commonService.add.mockResolvedValue(undefined);
      commonService.invalidate.mockResolvedValue(undefined);

      const result = await service.execute(payload);

      expect(result).toEqual([11]);

      // Only product 1's first item was confirmable (available drops to 0
      // after the first reservation; product 2 has no stock at all).
      expect(commonService.add).toHaveBeenCalledWith(
        expect.objectContaining({
          items: [expect.objectContaining({ productId: 1, orderProductId: 11, quantity: -1 })],
        }),
        txEm,
      );
      expect(commonService.invalidate).toHaveBeenCalledWith({
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

      await expect(service.execute(payload)).rejects.toBe(err);

      expect(logger.error).toHaveBeenCalledWith(
        { err, correlationId, productIds: [1], pendingCount: 1 },
        'Error reserving stock for order products',
      );
      expect(commonService.invalidate).not.toHaveBeenCalled();
    });

    it('orders add (in-transaction) before invalidate (post-commit)', async () => {
      const payload: IProductStockOrderConfirmPayload = {
        products: [pendingProduct(11, 1)],
        correlationId,
      };
      commonService.getMapLocked.mockResolvedValue(new Map([[1, 5]]));
      commonService.add.mockResolvedValue(undefined);
      commonService.invalidate.mockResolvedValue(undefined);

      await service.execute(payload);

      const addOrder = commonService.add.mock.invocationCallOrder[0];
      const invalidateOrder = commonService.invalidate.mock.invocationCallOrder[0];
      expect(addOrder).toBeLessThan(invalidateOrder);
    });
  });
});
