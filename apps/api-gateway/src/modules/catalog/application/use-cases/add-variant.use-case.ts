import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ProductVariantView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort, ICreateVariantCommand } from '../ports';

@Injectable()
export class AddVariantUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(AddVariantUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    command: ICreateVariantCommand,
    correlationId: string,
  ): Promise<ProductVariantView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { productId: command.productId, sku: command.sku },
        'Adding variant to catalog product',
      );

      const variant = await this.catalogGateway.createVariant(command, correlationId);

      this.logger.info(
        { productId: variant.productId, variantId: variant.id },
        'Catalog variant added',
      );

      return variant;
    } catch (error) {
      this.logger.error(error, 'Error adding catalog variant');

      throwRpcError(error);
    }
  }
}
