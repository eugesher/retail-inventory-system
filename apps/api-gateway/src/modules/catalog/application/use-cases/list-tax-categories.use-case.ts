import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { TaxCategoryView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { CATALOG_GATEWAY_PORT, ICatalogGatewayPort } from '../ports';

// List the (small, static) set of tax categories. There is nothing to scope by,
// so the query carries only the transport `correlationId`.
@Injectable()
export class ListTaxCategoriesUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(ListTaxCategoriesUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(correlationId: string): Promise<TaxCategoryView[]> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info('Listing tax categories');

      const taxCategories = await this.catalogGateway.listTaxCategories(correlationId);

      this.logger.info({ count: taxCategories.length }, 'Tax categories listed');

      return taxCategories;
    } catch (error) {
      this.logger.error(error, 'Error listing tax categories');

      throwRpcError(error);
    }
  }
}
