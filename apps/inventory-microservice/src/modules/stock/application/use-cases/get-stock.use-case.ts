import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { EntityManager } from 'typeorm';

import {
  IProductStockGetPayload,
  ProductStockGetResponseDto,
} from '@retail-inventory-system/contracts';

import { IStockCachePort, IStockRepositoryPort, STOCK_CACHE, STOCK_REPOSITORY } from '../ports';

interface IGetStockOptions {
  entityManager?: EntityManager;
  ignoreCache?: boolean;
}

@Injectable()
export class GetStockUseCase {
  constructor(
    @Inject(STOCK_REPOSITORY)
    private readonly repository: IStockRepositoryPort,
    @Inject(STOCK_CACHE)
    private readonly stockCache: IStockCachePort,
    @InjectPinoLogger(GetStockUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    payload: IProductStockGetPayload,
    options: IGetStockOptions = {},
  ): Promise<ProductStockGetResponseDto> {
    const { productId, storageIds, correlationId } = payload;
    const { entityManager, ignoreCache = false } = options;

    this.logger.info(payload, 'Received RPC: get product stock');

    try {
      // A read inside a caller-owned transaction can see uncommitted rows;
      // caching that data would corrupt the shared cache for other callers.
      const skipReason = entityManager ? 'entityManager' : ignoreCache ? 'ignoreCache' : null;

      if (skipReason !== null) {
        this.logger.debug(
          { correlationId, productId, reason: skipReason },
          'Cache skipped for stock query',
        );

        return this.repository.aggregateForProduct(
          { productId, storageIds, correlationId },
          entityManager,
        );
      }

      const cached = await this.stockCache.get({ productId, storageIds, correlationId });

      // Strict undefined check matches the cache adapter's miss/error contract:
      // both miss and read-error return undefined. Avoid coupling to the
      // invariant that response DTOs are always non-null objects.
      if (cached !== undefined) {
        return cached;
      }

      // Cache-aside read/write race window — between this miss and the
      // cache.set below, a concurrent writer could commit + SCAN-invalidate,
      // then we'd write the now-stale DB result back to the cache. No
      // single-flight / version stamp here today; tracked for a future pass.
      // AUDIT-2026-05-08 [CACHE-001]
      const data = await this.repository.aggregateForProduct({
        productId,
        storageIds,
        correlationId,
      });

      await this.stockCache.set({ productId, storageIds, data, correlationId });

      return data;
    } catch (error) {
      this.logger.error({ err: error as Error, ...payload }, 'Error retrieving product stock');

      throw error;
    }
  }
}
