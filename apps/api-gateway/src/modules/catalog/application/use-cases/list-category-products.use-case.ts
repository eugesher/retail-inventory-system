import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IPage, ProductWithVariantsView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort, ICategoryProductsCommand } from '../ports';

@Injectable()
export class ListCategoryProductsUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(ListCategoryProductsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    query: ICategoryProductsCommand,
    correlationId: string,
  ): Promise<IPage<ProductWithVariantsView>> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(query, 'Listing products in catalog category');

      const page = await this.catalogGateway.listCategoryProducts(query, correlationId);

      this.logger.info(
        { slug: query.slug, total: page.total, page: page.page },
        'Catalog category products listed',
      );

      return page;
    } catch (error) {
      this.logger.error(error, 'Error listing catalog category products');

      throwRpcError(error);
    }
  }
}
