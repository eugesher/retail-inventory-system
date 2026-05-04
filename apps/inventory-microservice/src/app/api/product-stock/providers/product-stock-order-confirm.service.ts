import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Repository } from 'typeorm';

import { OrderProductStatusEnum } from '@retail-inventory-system/retail';
import {
  INVENTORY_DEFAULT_STORAGE,
  IProductStockOrderConfirmPayload,
  ProductStockActionEnum,
} from '@retail-inventory-system/inventory';
import { ProductStock } from '../../../common/entities';
import { IProductStockCommonAddItem, ProductStockCommonService } from '../../../common/modules';

@Injectable()
export class ProductStockOrderConfirmService {
  constructor(
    @InjectRepository(ProductStock)
    private readonly productStockRepository: Repository<ProductStock>,
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

    try {
      await this.productStockRepository.manager.transaction(async (entityManager) => {
        const stockBalances: { productId: string; totalQuantity: string }[] = await entityManager
          .createQueryBuilder(ProductStock, 'ps')
          .select('ps.productId', 'productId')
          .addSelect('SUM(ps.quantity)', 'totalQuantity')
          .where('ps.productId IN (:...productIds)', { productIds })
          .groupBy('ps.productId')
          .setLock('pessimistic_write')
          .getRawMany();

        this.logger.debug(
          { correlationId, productIds, stockBalanceCount: stockBalances.length },
          'Stock balances loaded from DB',
        );

        const stockMap = new Map<number, number>(
          stockBalances.map(({ productId, totalQuantity }) => [
            Number(productId),
            Number(totalQuantity),
          ]),
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

    return confirmedIds;
  }
}
