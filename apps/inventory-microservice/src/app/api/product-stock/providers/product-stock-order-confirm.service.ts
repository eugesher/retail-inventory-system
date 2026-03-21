import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import {
  INVENTORY_DEFAULT_STORAGE,
  ProductStockActionEnum,
} from '@retail-inventory-system/inventory';
import { IOrderProductConfirmItem, OrderProductStatusEnum } from '@retail-inventory-system/retail';
import { ProductStock } from '../../../common/entities';

@Injectable()
export class ProductStockOrderConfirmService {
  constructor(
    @InjectRepository(ProductStock)
    private readonly productStockRepository: Repository<ProductStock>,
  ) {}

  public async execute(items: IOrderProductConfirmItem[]): Promise<number[]> {
    // 3.2: Keep only PENDING items
    const pendingItems = items.filter((item) => item.statusId === OrderProductStatusEnum.PENDING);

    if (pendingItems.length === 0) {
      return [];
    }

    // 3.3: Collect unique productIds for the balance query
    const productIds = [...new Set(pendingItems.map((i) => i.productId))];
    const confirmedIds: number[] = [];

    await this.productStockRepository.manager.transaction(async (manager) => {
      // 3.3: Single query — current balance per productId
      const stockBalances: { productId: string; totalQuantity: string }[] = await manager
        .createQueryBuilder(ProductStock, 'ps')
        .select('ps.productId', 'productId')
        .addSelect('SUM(ps.quantity)', 'totalQuantity')
        .where('ps.productId IN (:...productIds)', { productIds })
        .groupBy('ps.productId')
        .getRawMany();

      // Mutable stock map for partial-fulfillment tracking
      const stockMap = new Map<number, number>(
        stockBalances.map(({ productId, totalQuantity }) => [
          Number(productId),
          Number(totalQuantity),
        ]),
      );

      // 3.4: Process one by one in insertion order
      for (const item of pendingItems) {
        const available = stockMap.get(item.productId) ?? 0;

        if (available > 0) {
          const stockRecord = manager.create(ProductStock, {
            productId: item.productId,
            storageId: INVENTORY_DEFAULT_STORAGE,
            actionId: ProductStockActionEnum.ORDER_PRODUCT_CONFIRM,
            quantity: -1,
            orderProductId: item.id,
          });

          await manager.save(ProductStock, stockRecord);
          stockMap.set(item.productId, available - 1);
          confirmedIds.push(item.id);
        }
      }
    });

    return confirmedIds;
  }
}
