import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IPriceQuery, PriceView } from '@retail-inventory-system/contracts';

import { Price } from '../../domain';
import { IPricingRepositoryPort, PRICING_REPOSITORY } from '../ports';
import { toPriceView } from './price-view.factory';

// Select Applicable Price — the deterministic `(variantId, currency, asOf)` → one
// Price answer. It backs the GET single-price endpoint and (later) the publish
// precondition. The repository returns the **coarse** candidate set (every row
// whose `[validFrom, validTo)` interval contains `asOf`); the **resolution** —
// highest `priority`, then latest `validFrom` — lives **here**, not in SQL, so it
// stays unit-testable against an in-memory repository double and free to evolve
// without a schema change (ADR-026).
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

  // Pick policy: highest `priority` wins; on a tie, the most recently started
  // (latest `validFrom`) wins. Pure and static so it can be reasoned about (and
  // reused) without an instance. Returns `null` for an empty candidate set.
  public static resolve(candidates: readonly Price[]): Price | null {
    if (candidates.length === 0) {
      return null;
    }

    return [...candidates].sort(
      (a, b) => b.priority - a.priority || b.validFrom.getTime() - a.validFrom.getTime(),
    )[0];
  }
}
