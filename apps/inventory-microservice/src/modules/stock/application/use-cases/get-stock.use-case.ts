import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IProductStockGetPayload,
  ProductStockGetResponseDto,
} from '@retail-inventory-system/contracts';

import {
  IStockCachePort,
  IStockRepositoryPort,
  ITransactionScope,
  STOCK_CACHE,
  STOCK_REPOSITORY,
} from '../ports';

interface IGetStockOptions {
  scope?: ITransactionScope;
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
    const { scope, ignoreCache = false } = options;

    this.logger.info(payload, 'Received RPC: get product stock');

    try {
      // A read inside a caller-owned transaction can see uncommitted rows;
      // caching that would corrupt the shared cache for other callers.
      const skipReason = scope ? 'transactionScope' : ignoreCache ? 'ignoreCache' : null;

      if (skipReason !== null) {
        this.logger.debug(
          { correlationId, productId, reason: skipReason },
          'Cache skipped for stock query',
        );

        return this.repository.aggregateForProduct({ productId, storageIds, correlationId }, scope);
      }

      return await this.stockCache.getOrLoad({ productId, storageIds, correlationId }, () =>
        this.repository.aggregateForProduct({ productId, storageIds, correlationId }),
      );
    } catch (error) {
      this.logger.error({ err: error as Error, ...payload }, 'Error retrieving product stock');

      throw error;
    }
  }
}
