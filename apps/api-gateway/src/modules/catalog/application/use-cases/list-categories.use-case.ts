import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CategoryView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort, IListCategoriesCommand } from '../ports';

@Injectable()
export class ListCategoriesUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(ListCategoriesUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    query: IListCategoriesCommand,
    correlationId: string,
  ): Promise<CategoryView[]> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info({ rootOnly: query.rootOnly ?? false }, 'Listing catalog categories');

      const categories = await this.catalogGateway.listCategories(query, correlationId);

      this.logger.info({ count: categories.length }, 'Catalog categories listed');

      return categories;
    } catch (error) {
      this.logger.error(error, 'Error listing catalog categories');

      throwRpcError(error);
    }
  }
}
