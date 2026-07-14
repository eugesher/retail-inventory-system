import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { PriceView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import {
  CATALOG_GATEWAY_DEFAULT_CURRENCY,
  CATALOG_GATEWAY_PORT,
  ICatalogGatewayPort,
  IPriceQueryCommand,
  IPriceQueryRequest,
} from '../ports';

// Select Applicable Price: the deterministic `(variantId, currency, asOf)` → a
// single Price, or `null` when none is in effect. The `null` is surfaced
// unchanged (the route returns `200` with a `null` body); the resolution policy
// (priority DESC, then validFrom DESC) lives in the catalog use case, not here.
@Injectable()
export class GetApplicablePriceUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @Inject(CATALOG_GATEWAY_DEFAULT_CURRENCY)
    private readonly defaultCurrency: string,
    @InjectPinoLogger(GetApplicablePriceUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    query: IPriceQueryRequest,
    correlationId: string,
  ): Promise<PriceView | null> {
    this.logger.assign({ correlationId });

    // **Resolve the currency scope BEFORE the RPC** (ISSUE-11). The caller may omit `?currency=`; the
    // DTO no longer fills it with a literal `'USD'`, so this is where it acquires a value — from the
    // deployment's configured `DEFAULT_CURRENCY`, the same variable the catalog prices against.
    //
    // On a shop configured `DEFAULT_CURRENCY=EUR`, this endpoint used to ask the catalog for a **USD**
    // price it does not stock and answer `200` with a `null` body — for every variant.
    const command: IPriceQueryCommand = {
      ...query,
      currency: query.currency ?? this.defaultCurrency,
    };

    try {
      this.logger.info(
        { variantId: command.variantId, currency: command.currency, asOf: command.asOf },
        'Selecting applicable variant price',
      );

      const price = await this.catalogGateway.getApplicablePrice(command, correlationId);

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
