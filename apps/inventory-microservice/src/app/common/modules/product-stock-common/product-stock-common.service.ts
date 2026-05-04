import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EntityManager } from 'typeorm';

import { ProductStockGetResponseDto } from '@retail-inventory-system/inventory';
import {
  IProductStockCommonAdd,
  IProductStockCommonCacheInvalidate,
  IProductStockCommonGet,
  IProductStockCommonGetOptions,
  IProductStockCommonMapGetLocked,
} from './interfaces';
import {
  ProductStockCommonAddService,
  ProductStockCommonCacheService,
  ProductStockCommonGetService,
} from './providers';

@Injectable()
export class ProductStockCommonService {
  constructor(
    private readonly productStockCommonAddService: ProductStockCommonAddService,
    private readonly productStockCommonGetService: ProductStockCommonGetService,
    private readonly productStockCommonCacheService: ProductStockCommonCacheService,
    @InjectPinoLogger(ProductStockCommonService.name)
    private readonly logger: PinoLogger,
  ) {}

  public async add(payload: IProductStockCommonAdd, entityManager?: EntityManager): Promise<void> {
    const { items, correlationId } = payload;

    this.logger.debug(
      { correlationId, itemCount: items.length, withinTransaction: !!entityManager },
      'Delegating to ProductStockCommonAddService',
    );

    return await this.productStockCommonAddService.execute(payload, entityManager);
  }

  public async get(
    payload: IProductStockCommonGet,
    options: IProductStockCommonGetOptions = {},
  ): Promise<ProductStockGetResponseDto> {
    const { productId, storageIds, correlationId } = payload;
    const { entityManager, ignoreCache = false } = options;
    // A read inside a caller-owned transaction can see uncommitted rows; caching
    // that data would corrupt the shared cache for other callers.
    const skipCache = ignoreCache || !!entityManager;

    if (!skipCache) {
      const cached = await this.productStockCommonCacheService.get({
        productId,
        storageIds,
        correlationId,
      });

      if (cached) {
        return cached;
      }
    } else {
      this.logger.debug(
        {
          correlationId,
          productId,
          reason: entityManager ? 'entityManager' : 'ignoreCache',
        },
        'Cache skipped for stock query',
      );
    }

    const data = await this.productStockCommonGetService.execute(payload, entityManager);

    if (!skipCache) {
      await this.productStockCommonCacheService.set({ productId, storageIds, data, correlationId });
    }

    return data;
  }

  public async getMapLocked(
    payload: IProductStockCommonMapGetLocked,
    entityManager: EntityManager,
  ): Promise<Map<number, number>> {
    this.logger.debug(payload, 'Delegating to ProductStockCommonAddService');

    return this.productStockCommonGetService.getMapLocked(payload, entityManager);
  }

  // Invalidate cached stock entries for the given (productId, storageId) pairs.
  // Callers running inside a transaction MUST invoke this only after a successful
  // commit — invalidating mid-transaction can race with concurrent readers and
  // re-populate the cache with pre-commit (uncommitted) data.
  public async invalidate(payload: IProductStockCommonCacheInvalidate): Promise<void> {
    this.logger.debug(
      { correlationId: payload.correlationId, itemCount: payload.items.length },
      'Delegating to ProductStockCommonCacheService.invalidate',
    );

    return this.productStockCommonCacheService.invalidate(payload);
  }
}
