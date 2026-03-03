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
    const { productId, storeIds } = data;

    const builder = this.productStockRepository
      .createQueryBuilder('ProductStock')
      .where('ProductStock.productId = :productId', { productId });

    if (storeIds && storeIds.length > 0) {
      builder.andWhere('ProductStock.storeId IN (:...storeIds)', { storeIds });
    }

    const stock = await builder.getMany();
    const items = stock.map((item) => omit(item, 'productId'));
    const quantity = sumBy(stock, 'quantity');
    const updatedAt = maxBy(stock, 'updatedAt')?.updatedAt ?? new Date();

    return { productId, quantity, updatedAt, items };
  }
}
