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

// List every Price row in effect for `(variantId, currency)` at `asOf` (no
// collapse — the resolution to a single applicable price is a separate query).
@Injectable()
export class ListPricesUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @Inject(CATALOG_GATEWAY_DEFAULT_CURRENCY)
    private readonly defaultCurrency: string,
    @InjectPinoLogger(ListPricesUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(query: IPriceQueryRequest, correlationId: string): Promise<PriceView[]> {
    this.logger.assign({ correlationId });

    // **Resolve the currency scope BEFORE the RPC** (ISSUE-11) — see `GetApplicablePriceUseCase`. On a
    // non-USD shop this endpoint used to answer `[]` for every variant, because the DTO put `USD` on the
    // wire for a caller who never asked for it.
    const command: IPriceQueryCommand = {
      ...query,
      currency: query.currency ?? this.defaultCurrency,
    };

    try {
      this.logger.info(
        { variantId: command.variantId, currency: command.currency, asOf: command.asOf },
        'Listing variant prices in effect',
      );

      const prices = await this.catalogGateway.listPrices(command, correlationId);

      this.logger.info(
        { variantId: query.variantId, count: prices.length },
        'Variant prices listed',
      );

      return prices;
    } catch (error) {
      this.logger.error(error, 'Error listing variant prices');

      throwRpcError(error);
    }
  }
}
