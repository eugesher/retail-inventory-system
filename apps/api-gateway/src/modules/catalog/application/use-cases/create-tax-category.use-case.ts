import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { TaxCategoryView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort, ICreateTaxCategoryCommand } from '../ports';

// Create a tax category (a classification label only — code + name; no
// rate/jurisdiction, ADR-026). A duplicate `code` is rejected downstream with a
// 409 (`TAX_CATEGORY_CODE_TAKEN`).
@Injectable()
export class CreateTaxCategoryUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(CreateTaxCategoryUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    command: ICreateTaxCategoryCommand,
    correlationId: string,
  ): Promise<TaxCategoryView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info({ code: command.code }, 'Creating tax category');

      const taxCategory = await this.catalogGateway.createTaxCategory(command, correlationId);

      this.logger.info(
        { taxCategoryId: taxCategory.id, code: taxCategory.code },
        'Tax category created',
      );

      return taxCategory;
    } catch (error) {
      this.logger.error(error, 'Error creating tax category');

      throwRpcError(error);
    }
  }
}
