import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IAttachVariantTaxCategoryPayload,
  VariantTaxHeaderView,
} from '@retail-inventory-system/contracts';

import { PricingDomainException, PricingErrorCodeEnum } from '../../domain';
import { IPricingRepositoryPort, PRICING_REPOSITORY } from '../ports';

@Injectable()
export class AttachTaxCategoryToVariantUseCase {
  constructor(
    @Inject(PRICING_REPOSITORY)
    private readonly repository: IPricingRepositoryPort,
    @InjectPinoLogger(AttachTaxCategoryToVariantUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IAttachVariantTaxCategoryPayload): Promise<VariantTaxHeaderView> {
    const { variantId, taxCategoryCode, correlationId } = payload;

    this.logger.info(
      { correlationId, variantId, taxCategoryCode },
      'Received RPC: set variant tax category',
    );

    const taxCategory = await this.repository.findTaxCategoryByCode(taxCategoryCode);
    if (taxCategory === null) {
      throw new PricingDomainException(
        PricingErrorCodeEnum.TAX_CATEGORY_NOT_FOUND,
        `No tax category exists with code "${taxCategoryCode}".`,
      );
    }

    const before = await this.repository.findVariantTaxHeader(variantId);
    if (before === null) {
      throw new PricingDomainException(
        PricingErrorCodeEnum.VARIANT_NOT_FOUND,
        `No variant exists with id ${variantId}.`,
      );
    }

    await this.repository.attachTaxCategoryToVariant(variantId, taxCategory.id!);

    const after = await this.repository.findVariantTaxHeader(variantId);
    if (after === null) {
      throw new Error(
        `AttachTaxCategoryToVariantUseCase: variant ${variantId} vanished after attach`,
      );
    }

    this.logger.info(
      { correlationId, variantId, taxCategoryId: after.taxCategoryId, code: after.taxCategoryCode },
      'Variant tax category set',
    );

    return after;
  }
}
