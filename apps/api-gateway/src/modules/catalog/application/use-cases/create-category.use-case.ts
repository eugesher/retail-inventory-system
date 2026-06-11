import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CategoryView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort, ICreateCategoryCommand } from '../ports';

@Injectable()
export class CreateCategoryUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(CreateCategoryUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    command: ICreateCategoryCommand,
    correlationId: string,
  ): Promise<CategoryView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { slug: command.slug, parentSlug: command.parentSlug },
        'Creating catalog category',
      );

      const category = await this.catalogGateway.createCategory(command, correlationId);

      this.logger.info(
        { categoryId: category.id, path: category.path },
        'Catalog category created',
      );

      return category;
    } catch (error) {
      this.logger.error(error, 'Error creating catalog category');

      throwRpcError(error);
    }
  }
}
