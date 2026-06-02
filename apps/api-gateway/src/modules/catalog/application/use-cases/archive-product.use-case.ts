import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ProductView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort } from '../ports';

@Injectable()
export class ArchiveProductUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(ArchiveProductUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(productId: number, correlationId: string): Promise<ProductView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info({ productId }, 'Archiving catalog product');

      const product = await this.catalogGateway.archiveProduct(productId, correlationId);

      this.logger.info(
        { productId: product.id, status: product.status },
        'Catalog product archived',
      );

      return product;
    } catch (error) {
      this.logger.error(error, 'Error archiving catalog product');

      throwRpcError(error);
    }
  }
}
