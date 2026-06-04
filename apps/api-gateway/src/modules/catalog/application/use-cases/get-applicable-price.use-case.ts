import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { PriceView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort, IPriceQueryCommand } from '../ports';

// Select Applicable Price: the deterministic `(variantId, currency, asOf)` → a
// single Price, or `null` when none is in effect. The `null` is surfaced
// unchanged (the route returns `200` with a `null` body); the resolution policy
// (priority DESC, then validFrom DESC) lives in the catalog use case, not here.
@Injectable()
export class GetApplicablePriceUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(GetApplicablePriceUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    query: IPriceQueryCommand,
    correlationId: string,
  ): Promise<PriceView | null> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { variantId: query.variantId, currency: query.currency, asOf: query.asOf },
        'Selecting applicable variant price',
      );

      const price = await this.catalogGateway.getApplicablePrice(query, correlationId);

      this.logger.info(
        { variantId: query.variantId, priceId: price?.id ?? null },
        'Applicable variant price resolved',
      );

      return price;
    } catch (error) {
      this.logger.error(error, 'Error selecting applicable variant price');

      throwRpcError(error);
    }
  }
}
