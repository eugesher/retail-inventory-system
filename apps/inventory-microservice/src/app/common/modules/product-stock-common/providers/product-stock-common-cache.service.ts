import { Cache, CACHE_MANAGER } from '@nestjs/cache-manager';
import { Inject, Injectable } from '@nestjs/common';
import { isDefined } from 'class-validator';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CacheHelper } from '@retail-inventory-system/common';
import { ProductStockGetResponseDto } from '@retail-inventory-system/inventory';
import { IProductStockCommonCacheGet, IProductStockCommonCacheSet } from '../interfaces';

@Injectable()
export class ProductStockCommonCacheService {
  constructor(
    @Inject(CACHE_MANAGER)
    private readonly cache: Cache,
    @InjectPinoLogger(ProductStockCommonCacheService.name)
    private readonly logger: PinoLogger,
  ) {}

  public async get(
    payload: IProductStockCommonCacheGet,
  ): Promise<ProductStockGetResponseDto | undefined> {
    const { productId, storageIds, correlationId } = payload;

    const cacheKey = CacheHelper.keys.productStock(productId, storageIds);

    try {
      const cached = await this.cache.get<ProductStockGetResponseDto>(cacheKey);
      const cacheHit = isDefined(cached);

      this.logger.debug(
        { correlationId, productId, cacheKey, cacheHit },
        cacheHit ? 'Cache hit for stock query' : 'Cache miss for stock query',
      );

      return cached;
    } catch (error) {
      this.logger.warn(
        { correlationId, productId, cacheKey, ...error },
        'Failed to read from cache',
      );
    }
  }

  public async set(payload: IProductStockCommonCacheSet): Promise<void> {
    const { productId, storageIds, data, correlationId } = payload;

    const cacheKey = CacheHelper.keys.productStock(productId, storageIds);
    const ttl = CacheHelper.ttlValues.productStock;

    try {
      await this.cache.set(cacheKey, data, ttl);

      this.logger.debug({ correlationId, productId, cacheKey, ttl }, 'Cache write for stock query');
    } catch (error) {
      this.logger.warn(
        { correlationId, productId, cacheKey, ...error },
        'Failed to write to cache',
      );
    }
  }
}
