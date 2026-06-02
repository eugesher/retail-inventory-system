import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { VariantWithProductView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort } from '../ports';

@Injectable()
export class GetVariantUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(GetVariantUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(variantId: number, correlationId: string): Promise<VariantWithProductView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info({ variantId }, 'Fetching catalog variant');

      const variant = await this.catalogGateway.getVariant(variantId, correlationId);

      this.logger.info(
        { variantId: variant.id, productId: variant.product.id },
        'Catalog variant fetched',
      );

      return variant;
    } catch (error) {
      this.logger.error(error, 'Error fetching catalog variant');

      throwRpcError(error);
    }
  }
}
