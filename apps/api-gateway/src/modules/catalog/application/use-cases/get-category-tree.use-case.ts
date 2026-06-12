import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CategoryTreeNodeView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort } from '../ports';

@Injectable()
export class GetCategoryTreeUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(GetCategoryTreeUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(slug: string, correlationId: string): Promise<CategoryTreeNodeView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info({ slug }, 'Fetching catalog category tree');

      const tree = await this.catalogGateway.getCategoryTree(slug, correlationId);

      this.logger.info(
        { categoryId: tree.id, childCount: tree.children.length },
        'Catalog category tree fetched',
      );

      return tree;
    } catch (error) {
      this.logger.error(error, 'Error fetching catalog category tree');

      throwRpcError(error);
    }
  }
}
