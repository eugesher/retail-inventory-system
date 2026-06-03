import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ProductWithVariantsView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort } from '../ports';

@Injectable()
export class GetProductUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(GetProductUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(slug: string, correlationId: string): Promise<ProductWithVariantsView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info({ slug }, 'Fetching catalog product by slug');

      const product = await this.catalogGateway.getProductBySlug(slug, correlationId);

      this.logger.info(
        { productId: product.id, variantCount: product.variants.length },
        'Catalog product fetched',
      );

      return product;
    } catch (error) {
      this.logger.error(error, 'Error fetching catalog product');

      throwRpcError(error);
    }
  }
}
