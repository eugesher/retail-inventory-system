import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { PriceView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort, IPriceQueryCommand } from '../ports';

// List every Price row in effect for `(variantId, currency)` at `asOf` (no
// collapse — the resolution to a single applicable price is a separate query).
@Injectable()
export class ListPricesUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(ListPricesUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(query: IPriceQueryCommand, correlationId: string): Promise<PriceView[]> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { variantId: query.variantId, currency: query.currency, asOf: query.asOf },
        'Listing variant prices in effect',
      );

      const prices = await this.catalogGateway.listPrices(query, correlationId);

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
