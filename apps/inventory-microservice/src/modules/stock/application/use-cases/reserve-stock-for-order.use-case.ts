import { Inject, Injectable } from '@nestjs/common';
// TODO(task-14): replace the raw `@nestjs/typeorm` + `EntityManager` seam
// with an `ITransactionPort` so this use case no longer reaches into the
// ORM directly. Tracked in _carryover-12.md as ARCH-LINT-EX-01.
import { InjectEntityManager } from '@nestjs/typeorm'; // eslint-disable-line boundaries/dependencies
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EntityManager } from 'typeorm';

import {
  INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD,
  INVENTORY_DEFAULT_STORAGE,
  IProductStockOrderConfirmPayload,
  OrderProductStatusEnum,
  ProductStockActionEnum,
} from '@retail-inventory-system/contracts';

import { StockLowEvent } from '../../domain';
import {
  IStockAppendDeltaItem,
  IStockCachePort,
  IStockEventsPublisherPort,
  IStockRepositoryPort,
  STOCK_CACHE,
  STOCK_EVENTS_PUBLISHER,
  STOCK_REPOSITORY,
} from '../ports';

@Injectable()
export class ReserveStockForOrderUseCase {
  constructor(
    @InjectEntityManager()
    private readonly entityManager: EntityManager,
    @Inject(STOCK_REPOSITORY)
    private readonly repository: IStockRepositoryPort,
    @Inject(STOCK_CACHE)
    private readonly stockCache: IStockCachePort,
    @Inject(STOCK_EVENTS_PUBLISHER)
    private readonly publisher: IStockEventsPublisherPort,
    @InjectPinoLogger(ReserveStockForOrderUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IProductStockOrderConfirmPayload): Promise<number[]> {
    const { products, correlationId } = payload;

    const pendingItems = products.filter(
      (item) => item.statusId === OrderProductStatusEnum.PENDING,
    );

    this.logger.info(
      { correlationId, totalProducts: products.length, pendingCount: pendingItems.length },
      'Received RPC: reserve order product stock',
    );

    if (pendingItems.length === 0) {
      this.logger.info({ correlationId }, 'No pending products to reserve stock for');
      return [];
    }

    const productIds = [...new Set(pendingItems.map((i) => i.productId))];
    const confirmedIds: number[] = [];
    // Captured inside the transaction; consumed after commit to decide
    // whether each (productId, storageId) crossed the low-stock threshold.
    const postCommitQuantities = new Map<string, number>();

    let items: IStockAppendDeltaItem[] = [];
    try {
      // ADR-023: `withInvalidation` runs the transaction work first and only
      // fires the cache prefix-delete on resolution. The post-commit
      // ordering is encoded in the helper — there is no public `invalidate`
      // call to misuse from inside the transaction callback.
      items = await this.stockCache.withInvalidation(
        async () => {
          const acc: IStockAppendDeltaItem[] = [];
          await this.entityManager.transaction(async (entityManager) => {
            const stockMap = await this.repository.lockedTotalsByProduct(
              { productIds, correlationId },
              entityManager,
            );

            for (const item of pendingItems) {
              const available = stockMap.get(item.productId) ?? 0;

              if (available > 0) {
                acc.push({
                  productId: item.productId,
                  storageId: INVENTORY_DEFAULT_STORAGE,
                  actionId: ProductStockActionEnum.ORDER_PRODUCT_CONFIRM,
                  quantity: -1,
                  orderProductId: item.id,
                });
                stockMap.set(item.productId, available - 1);
                postCommitQuantities.set(
                  `${item.productId}:${INVENTORY_DEFAULT_STORAGE}`,
                  available - 1,
                );
                confirmedIds.push(item.id);
              }
            }

            if (acc.length > 0) {
              await this.repository.appendDeltas({ items: acc, correlationId }, entityManager);

              this.logger.info(
                {
                  correlationId,
                  confirmedCount: confirmedIds.length,
                  skippedCount: pendingItems.length - confirmedIds.length,
                },
                'Stock reserved for order products',
              );
            } else {
              this.logger.warn(
                { correlationId, pendingCount: pendingItems.length, productIds },
                'No stock available to reserve for any pending order products',
              );
            }
          });
          return acc;
        },
        // The !!item.storageId predicate is unreachable today. Every entry
        // pushed into the deltas above is constructed with `storageId:
        // INVENTORY_DEFAULT_STORAGE` (a non-empty string literal), so the
        // filter always returns true and the type guard always narrows. The
        // filter exists for a forward-looking state where some ledger writes
        // may target a NULL storage column (e.g. cross-storage adjustments)
        // — those rows must be excluded from invalidation because we cannot
        // point SCAN at a specific (productId, storageId) pair without a
        // storageId.
        //
        // Removing it now is not a pure dead-code deletion: the type
        // narrowing it produces (`item.storageId: string`) is what lets the
        // next .map() emit a `{ storageId: string }` shape that matches
        // IStockCacheInvalidateItem. A simpler `.map(...)` without the guard
        // would surface a `string | undefined` type error.
        // AUDIT-2026-05-08 [CODE-001]
        (acc) =>
          acc
            .filter((item): item is typeof item & { storageId: string } => !!item.storageId)
            .map(({ productId, storageId }) => ({ productId, storageId })),
        { correlationId },
      );
    } catch (error) {
      this.logger.error(
        { err: error as Error, correlationId, productIds, pendingCount: pendingItems.length },
        'Error reserving stock for order products',
      );

      throw error;
    }

    if (items.length > 0) {
      // Emit `inventory.stock.low` for every (productId, storageId) pair
      // whose post-commit quantity sits at-or-below the threshold. Errors
      // are warn-logged but never raised: the order confirm result must
      // not depend on the event broker's availability.
      for (const [key, quantity] of postCommitQuantities) {
        if (quantity > INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD) {
          continue;
        }
        const [productIdRaw, storageId] = key.split(':');
        const productId = Number(productIdRaw);
        const event = new StockLowEvent({
          productId,
          storageId,
          quantity,
          threshold: INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD,
        });
        try {
          await this.publisher.publishStockLow(event, correlationId);
        } catch (err) {
          this.logger.warn(
            { err: err as Error, correlationId, productId, storageId, quantity },
            'Failed to publish inventory.stock.low event',
          );
        }
      }
    }

    return confirmedIds;
  }
}
