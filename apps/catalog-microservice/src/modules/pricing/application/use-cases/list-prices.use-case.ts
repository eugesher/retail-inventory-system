import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IPriceQuery, PriceView } from '@retail-inventory-system/contracts';

import { IPricingRepositoryPort, PRICING_REPOSITORY } from '../ports';
import { toPriceView } from './price-view.factory';

@Injectable()
export class ListPricesUseCase {
  constructor(
    @Inject(PRICING_REPOSITORY)
    private readonly repository: IPricingRepositoryPort,
    @InjectPinoLogger(ListPricesUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(query: IPriceQuery): Promise<PriceView[]> {
    const { variantId, currency, asOf, correlationId } = query;
    const asOfDate = asOf === undefined ? new Date() : new Date(asOf);

    this.logger.info(
      { correlationId, variantId, currency, asOf: asOfDate.toISOString() },
      'Received RPC: list prices',
    );

    const rows = await this.repository.findInEffect(variantId, currency, asOfDate);

    return rows.map(toPriceView);
  }
}
