import { Injectable } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EntityManager } from 'typeorm';

import {
  INVENTORY_DEFAULT_STORAGE,
  IProductStockOrderConfirmPayload,
  ProductStockActionEnum,
} from '@retail-inventory-system/inventory';
import { OrderProductStatusEnum } from '@retail-inventory-system/retail';
import { IProductStockCommonAddItem, ProductStockCommonService } from '../../../common/modules';

@Injectable()
export class ProductStockOrderConfirmService {
  constructor(
    @InjectEntityManager()
    private readonly entityManager: EntityManager,
    private readonly productStockCommonService: ProductStockCommonService,
    @InjectPinoLogger(ProductStockOrderConfirmService.name)
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
    const mutatedItems: IProductStockCommonAddItem[] = [];

    try {
      await this.entityManager.transaction(async (entityManager) => {
        const stockMap = await this.productStockCommonService.getMapLocked(
          { productIds, correlationId },
          entityManager,
        );

        const items: IProductStockCommonAddItem[] = [];

        for (const item of pendingItems) {
          const available = stockMap.get(item.productId) ?? 0;

          if (available > 0) {
            items.push({
              productId: item.productId,
              storageId: INVENTORY_DEFAULT_STORAGE,
              actionId: ProductStockActionEnum.ORDER_PRODUCT_CONFIRM,
              quantity: -1,
              orderProductId: item.id,
            });
            stockMap.set(item.productId, available - 1);
            confirmedIds.push(item.id);
          }
        }

        if (items.length > 0) {
          await this.productStockCommonService.add({ items, correlationId }, entityManager);
          mutatedItems.push(...items);

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
    } catch (error) {
      this.logger.error(
        { ...error, correlationId, productIds, pendingCount: pendingItems.length },
        'Error reserving stock for order products',
      );

      throw error;
    }

    // Post-commit: invalidate cached stock for every (productId, storageId)
    // pair we just mutated. Must run after the transaction commits — calling
    // invalidate inside the callback would race with concurrent readers that
    // could re-populate the cache from uncommitted state.
    if (mutatedItems.length > 0) {
      const invalidateItems = mutatedItems
        .filter((item): item is typeof item & { storageId: string } => !!item.storageId)
        .map(({ productId, storageId }) => ({ productId, storageId }));

      if (invalidateItems.length > 0) {
        await this.productStockCommonService.invalidate({
          items: invalidateItems,
          correlationId,
        });
      }
    }

    return confirmedIds;
  }
}
