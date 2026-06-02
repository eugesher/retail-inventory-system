import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ProductView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort, IRegisterProductCommand } from '../ports';

@Injectable()
export class RegisterProductUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(RegisterProductUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    command: IRegisterProductCommand,
    correlationId: string,
  ): Promise<ProductView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info({ slug: command.slug }, 'Registering catalog product');

      const product = await this.catalogGateway.registerProduct(command, correlationId);

      this.logger.info({ productId: product.id, slug: product.slug }, 'Catalog product registered');

      return product;
    } catch (error) {
      this.logger.error(error, 'Error registering catalog product');

      throwRpcError(error);
    }
  }
}
