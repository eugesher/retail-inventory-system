import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ProductCategoriesView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort } from '../ports';

export interface IDetachProductCategoryInput {
  productId: number;
  categorySlug: string;
}

@Injectable()
export class DetachProductCategoryUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(DetachProductCategoryUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    input: IDetachProductCategoryInput,
    correlationId: string,
  ): Promise<ProductCategoriesView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { productId: input.productId, detachCategorySlug: input.categorySlug },
        'Detaching product from category',
      );

      const result = await this.catalogGateway.reclassifyProduct(
        {
          productId: input.productId,
          attachCategorySlugs: [],
          detachCategorySlugs: [input.categorySlug],
        },
        correlationId,
      );

      this.logger.info(
        { productId: input.productId, categoryCount: result.categories.length },
        'Product detached from category',
      );

      return result;
    } catch (error) {
      this.logger.error(error, 'Error detaching product from category');

      throwRpcError(error);
    }
  }
}
