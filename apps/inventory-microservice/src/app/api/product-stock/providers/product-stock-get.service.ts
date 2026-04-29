import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { isDefined } from 'class-validator';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Repository } from 'typeorm';

import { CacheHelper } from '@retail-inventory-system/common';
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

  public async execute(payload: IProductStockGetPayload): Promise<ProductStockGetResponseDto> {
    try {
      this.logger.info(payload, 'Received RPC: get product stock');

      const cached = await this.getCache(payload);

      if (cached) {
        return cached;
      }

      const data = await this.getData(payload);

      await this.setCache(payload, data);

      return data;
    } catch (error) {
      this.logger.error({ ...payload, ...error }, 'Error retrieving product stock');

      throw error;
    }
  }

  private async getData(payload: IProductStockGetPayload): Promise<ProductStockGetResponseDto> {
    const { productId, storageIds, correlationId } = payload;

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

    let quantity = 0;
    let latestDate = new Date(0);

    const items = stock.map((item) => {
      const itemQuantity = Number(item.quantity);

      quantity += itemQuantity;

      if (item.updatedAt > latestDate) {
        latestDate = item.updatedAt;
      }

      return { storageId: item.storageId, quantity: itemQuantity, updatedAt: item.updatedAt };
    });
    const updatedAt = stock.length > 0 ? latestDate : null;

    return { productId, quantity, updatedAt, items };
  }

  private async getCache(
    payload: IProductStockGetPayload,
  ): Promise<ProductStockGetResponseDto | undefined> {
    const { productId, storageIds, correlationId } = payload;
    const cacheKey = CacheHelper.keys.productStock(productId, storageIds);

    try {
      const cached = await this.cache.get<ProductStockGetResponseDto>(cacheKey);
      const cacheHit = isDefined(cached);

      if (cacheHit) {
        this.logger.debug(
          { correlationId, productId, cacheKey, cacheHit },
          'Cache hit for stock query',
        );
      } else {
        this.logger.debug(
          { correlationId, productId, cacheKey, cacheHit },
          'Cache miss for stock query',
        );
      }

      return cached;
    } catch (error) {
      this.logger.warn(
        { correlationId, productId, cacheKey, ...error },
        'Failed to read from cache',
      );
    }
  }

  private async setCache(
    payload: IProductStockGetPayload,
    data: ProductStockGetResponseDto,
  ): Promise<void> {
    const { productId, storageIds, correlationId } = payload;
    const cacheKey = CacheHelper.keys.productStock(productId, storageIds);

    try {
      const ttl = CacheHelper.ttlValues.productStock;

      await this.cache.set(cacheKey, data, ttl);
    } catch (error) {
      this.logger.warn(
        { correlationId, productId, cacheKey, ...error },
        'Failed to write to cache',
      );
    }
  }
}
