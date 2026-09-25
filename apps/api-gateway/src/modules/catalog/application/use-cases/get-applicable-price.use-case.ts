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
