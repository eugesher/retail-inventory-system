import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ProductCategoriesView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort } from '../ports';

// Input for the `DELETE /api/catalog/products/:productId/categories/:categorySlug`
// route — both values come from path params.
export interface IDetachProductCategoryInput {
  productId: number;
  categorySlug: string;
}

// Folds the single-slug detach HTTP shape onto the `catalog.product.reclassify`
// RPC with an EMPTY attach list and a ONE-slug detach list. Detach is idempotent
// (removing a non-membership is a silent success) and a detach of an archived
// category is allowed — the microservice owns both rules.
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
