import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IPriceQuery, PriceView } from '@retail-inventory-system/contracts';

import { IPricingRepositoryPort, PRICING_REPOSITORY } from '../ports';
import { toPriceView } from './price-view.factory';

// List Prices — every Price row in effect for `(variantId, currency)` at `asOf`,
// mapped to `PriceView[]`. Unlike Select Applicable, it does not collapse the set
// to a single answer: it surfaces the whole in-effect candidate list (overlapping
// priorities included) so an operator can see what resolution is choosing
// between. `currency`/`asOf` defaulting is a gateway-DTO concern; here `asOf`
// falls back to now.
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
