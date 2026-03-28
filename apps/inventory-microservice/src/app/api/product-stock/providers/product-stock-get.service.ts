import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { IProductStockGetPayload, ProductStockDto } from '@retail-inventory-system/inventory';
import { ProductStock } from '../../../common/entities';
import { IProductStockGetRawResult } from '../interfaces';

@Injectable()
export class ProductStockGetService {
  constructor(
    @InjectRepository(ProductStock)
    private readonly productStockRepository: Repository<ProductStock>,
  ) {}

  public async execute(data: IProductStockGetPayload): Promise<ProductStockDto> {
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
      builder.andWhere('ProductStock.storageId IN (:...storageIds)', { storageIds });
    }

    const stock = await builder.getRawMany<IProductStockGetRawResult>();

    let totalQuantity = 0;
    let latestDate = new Date(0);

    const items = stock.map((item) => {
      const quantity = Number(item.quantity);
      totalQuantity += quantity;
      if (item.updatedAt > latestDate) latestDate = item.updatedAt;
      return { storageId: item.storageId, quantity, updatedAt: item.updatedAt };
    });
    const updatedAt = stock.length > 0 ? latestDate : null;

    return { productId, quantity: totalQuantity, updatedAt, items };
  }
}
