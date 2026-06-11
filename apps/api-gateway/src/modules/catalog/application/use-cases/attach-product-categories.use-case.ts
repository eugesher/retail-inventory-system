import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ProductCategoriesView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort } from '../ports';

// Input for the `POST /api/catalog/products/:productId/categories` route. The
// productId comes from the path param, the slugs from the request body.
export interface IAttachProductCategoriesInput {
  productId: number;
  categorySlugs: string[];
}

// Folds the attach-only HTTP shape onto the single `catalog.product.reclassify`
// RPC with an EMPTY detach list — the attach route and the detach route share one
// idempotent reclassify command (ADR-029).
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
