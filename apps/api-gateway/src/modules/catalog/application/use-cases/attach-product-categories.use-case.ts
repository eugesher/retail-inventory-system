import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ProductCategoriesView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort } from '../ports';

export interface IAttachProductCategoriesInput {
  productId: number;
  categorySlugs: string[];
}

@Injectable()
export class AttachProductCategoriesUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(AttachProductCategoriesUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    input: IAttachProductCategoriesInput,
    correlationId: string,
  ): Promise<ProductCategoriesView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { productId: input.productId, attachCategorySlugs: input.categorySlugs },
        'Attaching product to categories',
      );

      const result = await this.catalogGateway.reclassifyProduct(
        {
          productId: input.productId,
          attachCategorySlugs: input.categorySlugs,
          detachCategorySlugs: [],
        },
        correlationId,
      );

      this.logger.info(
        { productId: input.productId, categoryCount: result.categories.length },
        'Product attached to categories',
      );

      return result;
    } catch (error) {
      this.logger.error(error, 'Error attaching product to categories');

      throwRpcError(error);
    }
  }
}
