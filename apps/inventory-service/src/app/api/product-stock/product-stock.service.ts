import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { max, omit } from 'lodash';
import { Repository } from 'typeorm';

import { IProductStockGet, ProductStock, ProductStockDto } from '@retail-inventory/common';

@Injectable()
export class ProductStockService {
  constructor(
    @InjectRepository(ProductStock)
    private productStockRepository: Repository<ProductStock>,
  ) {}

  public async getProductStock(data: IProductStockGet): Promise<ProductStockDto> {
    const { productId, storeIds } = data;

    const builder = this.productStockRepository
      .createQueryBuilder('ProductStock')
      .where('ProductStock.productId = :productId', { productId });

    if (storeIds && storeIds.length > 0) {
      builder.andWhere('ProductStock.storeId IN (:...storeIds)', { storeIds });
    }

    const stock = await builder.getMany();

    return {
      productId: data.productId,
      stock: stock.map((item) => omit(item, 'productId')),
      updatedAt: max(stock.map(({ updatedAt }) => updatedAt)) ?? new Date(),
    };
  }
}
