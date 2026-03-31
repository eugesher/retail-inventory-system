import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DeepPartial, Repository } from 'typeorm';

import {
  INVENTORY_DEFAULT_STORAGE,
  IProductStockOrderConfirmPayload,
  ProductStockActionEnum,
} from '@retail-inventory-system/inventory';
import { OrderProductStatusEnum } from '@retail-inventory-system/retail';
import { ProductStock } from '../../../common/entities';

@Injectable()
export class ProductStockOrderConfirmService {
  constructor(
    @InjectRepository(ProductStock)
    private readonly productStockRepository: Repository<ProductStock>,
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

        const records: DeepPartial<ProductStock>[] = [];

        for (const item of pendingItems) {
          const available = stockMap.get(item.productId) ?? 0;

          if (available > 0) {
            records.push({
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

        if (records.length > 0) {
          await entityManager.insert(ProductStock, records);
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
      this.logger.error(error, 'Error reserving stock for order products');
      throw error;
    }

    return confirmedIds;
  }
}
