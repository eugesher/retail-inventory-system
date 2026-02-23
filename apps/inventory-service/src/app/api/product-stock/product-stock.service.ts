import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { max, omit } from 'lodash';
import { Repository } from 'typeorm';

import {
  ProductStockGetDto,
  ProductStock,
  ProductStockResponseDto,
} from '@retail-inventory/common';

@Injectable()
export class ProductStockService {
  constructor(
    @InjectRepository(ProductStock)
    private productStockRepository: Repository<ProductStock>,
  ) {}

  public async getProductStock(dto: ProductStockGetDto): Promise<ProductStockResponseDto> {
    const builder = this.productStockRepository
      .createQueryBuilder('ProductStock')
      .where('ProductStock.productId = :productId', { productId: dto.productId });

    if (dto.storeIds && dto.storeIds.length > 0) {
      builder.andWhere('ProductStock.storeId IN (:...storeIds)', { storeIds: dto.storeIds });
    }

    const stock = await builder.getMany();

    return {
      productId: dto.productId,
      stock: stock.map((item) => omit(item, 'productId')),
      updatedAt: max(stock.map(({ updatedAt }) => updatedAt)) ?? new Date(),
    };
  }
}
