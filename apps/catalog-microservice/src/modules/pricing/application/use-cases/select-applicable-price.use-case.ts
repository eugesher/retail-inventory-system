import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IPriceQuery, PriceView } from '@retail-inventory-system/contracts';

import { Price } from '../../domain';
import { IPricingRepositoryPort, PRICING_REPOSITORY } from '../ports';
import { toPriceView } from './price-view.factory';

@Injectable()
export class SelectApplicablePriceUseCase {
  constructor(
    @Inject(PRICING_REPOSITORY)
    private readonly repository: IPricingRepositoryPort,
    @InjectPinoLogger(SelectApplicablePriceUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(query: IPriceQuery): Promise<PriceView | null> {
    const { variantId, currency, asOf, correlationId } = query;
    const asOfDate = asOf === undefined ? new Date() : new Date(asOf);

    this.logger.info(
      { correlationId, variantId, currency, asOf: asOfDate.toISOString() },
      'Received RPC: select applicable price',
    );

    const candidates = await this.repository.findInEffect(variantId, currency, asOfDate);
    const applicable = SelectApplicablePriceUseCase.resolve(candidates);

    return applicable === null ? null : toPriceView(applicable);
  }

  public static resolve(candidates: readonly Price[]): Price | null {
    if (candidates.length === 0) {
      return null;
    }

    return [...candidates].sort(
      (a, b) => b.priority - a.priority || b.validFrom.getTime() - a.validFrom.getTime(),
    )[0];
  }
}
