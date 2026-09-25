import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { PriceView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort, ISetPriceCommand } from '../ports';

@Injectable()
export class SetPriceUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(SetPriceUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(command: ISetPriceCommand, correlationId: string): Promise<PriceView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { variantId: command.variantId, currency: command.currency },
        'Setting variant price',
      );

      const price = await this.catalogGateway.setPrice(command, correlationId);

      this.logger.info(
        { priceId: price.id, variantId: price.variantId, validFrom: price.validFrom },
        'Variant price set',
      );

      return price;
    } catch (error) {
      this.logger.error(error, 'Error setting variant price');

      throwRpcError(error);
    }
  }
}
