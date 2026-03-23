import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DeepPartial, Repository } from 'typeorm';

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
    const pendingItems = items.filter((item) => item.statusId === OrderProductStatusEnum.PENDING);

    if (pendingItems.length === 0) {
      return [];
    }

    const productIds = [...new Set(pendingItems.map((i) => i.productId))];
    const confirmedIds: number[] = [];

    await this.productStockRepository.manager.transaction(async (entityManager) => {
      const stockBalances: { productId: string; totalQuantity: string }[] = await entityManager
        .createQueryBuilder(ProductStock, 'ps')
        .select('ps.productId', 'productId')
        .addSelect('SUM(ps.quantity)', 'totalQuantity')
        .where('ps.productId IN (:...productIds)', { productIds })
        .groupBy('ps.productId')
        .getRawMany();

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
      }
    });

    return confirmedIds;
  }
}
