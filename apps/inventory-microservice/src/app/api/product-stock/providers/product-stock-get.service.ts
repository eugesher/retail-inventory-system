import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { maxBy, omit, sumBy } from 'lodash';
import { Repository } from 'typeorm';

import { IProductStockGet, ProductStockDto } from '@retail-inventory-system/inventory';
import { ProductStock } from '../../../common/entities';

@Injectable()
export class ProductStockGetService {
  constructor(
    @InjectRepository(ProductStock)
    private readonly productStockRepository: Repository<ProductStock>,
  ) {}

  public async execute(data: IProductStockGet): Promise<ProductStockDto> {
    interface IProductStockRaw {
      storageId: string;
      quantity: `${number}`;
      updatedAt: Date;
    }

    const { productId, storageIds } = data;

    const builder = this.productStockRepository
      .createQueryBuilder('ProductStock')
      .select([
        'ProductStock.storageId        AS storageId',
        'SUM(ProductStock.quantity)  AS quantity',
        'MAX(ProductStock.createdAt) AS updatedAt',
      ])
      .where('ProductStock.productId = :productId', { productId })
      .groupBy('storageId');

    if (storageIds && storageIds.length > 0) {
      builder.andWhere('ProductStock.storeId IN (:...storageIds)', { storageIds });
    }

    const stock = await builder.getRawMany<IProductStockRaw>();
    const items = stock.map((item) => ({
      ...omit(item, 'productId'),
      quantity: Number(item.quantity),
    }));
    const quantity = sumBy(items, 'quantity');
    const updatedAt = maxBy(stock, 'updatedAt')?.updatedAt ?? new Date();

    return { productId, quantity, updatedAt, items };
  }
}
