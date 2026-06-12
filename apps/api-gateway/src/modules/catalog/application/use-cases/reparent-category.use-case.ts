import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CategoryReparentView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort, IReparentCategoryCommand } from '../ports';

@Injectable()
export class ReparentCategoryUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(ReparentCategoryUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    command: IReparentCategoryCommand,
    correlationId: string,
  ): Promise<CategoryReparentView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { slug: command.slug, newParentSlug: command.newParentSlug ?? null },
        'Reparenting catalog category',
      );

      const result = await this.catalogGateway.reparentCategory(command, correlationId);

      this.logger.info(
        {
          categoryId: result.category.id,
          rewrittenDescendantCount: result.rewrittenDescendantCount,
        },
        'Catalog category reparented',
      );

      return result;
    } catch (error) {
      this.logger.error(error, 'Error reparenting catalog category');

      throwRpcError(error);
    }
  }
}
