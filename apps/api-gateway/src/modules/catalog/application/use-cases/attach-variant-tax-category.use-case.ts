import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { VariantTaxHeaderView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import {
  CATALOG_GATEWAY_PORT,
  IAttachVariantTaxCategoryCommand,
  ICatalogGatewayPort,
} from '../ports';

// Point a variant at a tax category by code (writes the
// `product_variant.tax_category_id` FK downstream). An unknown code → 404
// (`TAX_CATEGORY_NOT_FOUND`); an unknown variant → 404 (`VARIANT_NOT_FOUND`).
// Returns the minimal updated variant tax header, not the full variant view.
@Injectable()
export class AttachVariantTaxCategoryUseCase {
  constructor(
    @Inject(CATALOG_GATEWAY_PORT)
    private readonly catalogGateway: ICatalogGatewayPort,
    @InjectPinoLogger(AttachVariantTaxCategoryUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    command: IAttachVariantTaxCategoryCommand,
    correlationId: string,
  ): Promise<VariantTaxHeaderView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { variantId: command.variantId, taxCategoryCode: command.taxCategoryCode },
        'Attaching tax category to variant',
      );

      const header = await this.catalogGateway.attachVariantTaxCategory(command, correlationId);

      this.logger.info(
        { variantId: header.variantId, taxCategoryId: header.taxCategoryId },
        'Tax category attached to variant',
      );

      return header;
    } catch (error) {
      this.logger.error(error, 'Error attaching tax category to variant');

      throwRpcError(error);
    }
  }
}
