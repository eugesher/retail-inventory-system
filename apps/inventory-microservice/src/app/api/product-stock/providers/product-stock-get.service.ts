import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Repository } from 'typeorm';

import { CacheKeys } from '@retail-inventory-system/common';
import {
  IProductStockGetPayload,
  ProductStockGetResponseDto,
} from '@retail-inventory-system/inventory';
import { ProductStock } from '../../../common/entities';
import { IProductStockGetRawResult } from '../interfaces';

@Injectable()
export class ProductStockGetService {
  constructor(
    @Inject(CACHE_MANAGER)
    private readonly cache: Cache,
    @InjectRepository(ProductStock)
    private readonly productStockRepository: Repository<ProductStock>,
    @InjectPinoLogger(ProductStockGetService.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(data: IProductStockGetPayload): Promise<ProductStockGetResponseDto> {
    try {
      const { productId, storageIds, correlationId } = data;

      this.logger.info(data, 'Received RPC: get product stock');

      const cacheKey = CacheKeys.productStock(productId, storageIds);
      const cached = await this.cache.get<ProductStockGetResponseDto>(cacheKey);

      if (cached) {
        this.logger.debug(
          { correlationId, productId, cacheKey, hit: true },
          'Cache hit for stock query',
        );

        return cached;
      }

      this.logger.debug(
        { correlationId, productId, cacheKey, hit: false },
        'Cache miss for stock query',
      );

      const productStock = await this.getProductStock(data);
      const STOCK_CACHE_TTL = 60 * 1000; // TODO: Move

      await this.cache.set(cacheKey, productStock, STOCK_CACHE_TTL);

      return productStock;
    } catch (error) {
      this.logger.error(error, 'Error retrieving product stock');
      throw error;
    }
  }

  private async getProductStock(
    data: IProductStockGetPayload,
  ): Promise<ProductStockGetResponseDto> {
    const { productId, storageIds, correlationId } = data;

    const builder = this.productStockRepository
      .createQueryBuilder('ProductStock')
      .select([
        'ProductStock.storageId      AS storageId',
        'SUM(ProductStock.quantity)  AS quantity',
        'MAX(ProductStock.createdAt) AS updatedAt',
      ])
      .where('ProductStock.productId = :productId', { productId })
      .groupBy('storageId');

    if (storageIds && storageIds.length > 0) {
      builder.andWhere('ProductStock.storageId IN (:...storageIds)', { storageIds });
    }

    const stock = await builder.getRawMany<IProductStockGetRawResult>();

    this.logger.debug(
      { correlationId, productId, rowCount: stock.length },
      'Stock rows retrieved from DB',
    );

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
