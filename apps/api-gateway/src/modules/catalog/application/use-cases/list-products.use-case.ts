import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IPage, ProductWithVariantsView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort, IListProductsCommand } from '../ports';

@Injectable()
export class ListProductsUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(ListProductsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    query: IListProductsCommand,
    correlationId: string,
  ): Promise<IPage<ProductWithVariantsView>> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(query, 'Listing catalog products');

      const page = await this.catalogGateway.listProducts(query, correlationId);

      this.logger.info({ total: page.total, page: page.page }, 'Catalog products listed');

      return page;
    } catch (error) {
      this.logger.error(error, 'Error listing catalog products');

      throwRpcError(error);
    }
  }
}
