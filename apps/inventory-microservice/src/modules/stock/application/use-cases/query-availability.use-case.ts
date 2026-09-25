import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IVariantStockGetPayload, VariantStockView } from '@retail-inventory-system/contracts';

import { IStockCachePort, IStockRepositoryPort, STOCK_CACHE, STOCK_REPOSITORY } from '../ports';
import { toStockLevelView } from './stock-view.factory';

@Injectable()
export class QueryAvailabilityUseCase {
  constructor(
    @Inject(STOCK_REPOSITORY)
    private readonly repository: IStockRepositoryPort,
    @Inject(STOCK_CACHE)
    private readonly stockCache: IStockCachePort,
    @InjectPinoLogger(QueryAvailabilityUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IVariantStockGetPayload): Promise<VariantStockView> {
    const { variantId, stockLocationIds, correlationId } = payload;

    this.logger.info(payload, 'Received RPC: query variant availability');

    try {
      return await this.stockCache.getOrLoad({ variantId, stockLocationIds, correlationId }, () =>
        this.load(variantId, stockLocationIds),
      );
    } catch (error) {
      this.logger.error({ err: error as Error, ...payload }, 'Error querying variant availability');
      throw error;
    }
  }

  private async load(variantId: number, stockLocationIds?: string[]): Promise<VariantStockView> {
    const levels = await this.repository.findStockLevelsByVariant(variantId, stockLocationIds);

    const locations = levels
      .map((level) => toStockLevelView(level))
      .sort((a, b) => a.stockLocationId.localeCompare(b.stockLocationId));

    const totalOnHand = locations.reduce((sum, location) => sum + location.quantityOnHand, 0);
    const totalAvailable = locations.reduce((sum, location) => sum + location.available, 0);

    return { variantId, totalOnHand, totalAvailable, locations };
  }
}
