import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IAttachVariantTaxCategoryPayload,
  VariantTaxHeaderView,
} from '@retail-inventory-system/contracts';

import { PricingDomainException, PricingErrorCodeEnum } from '../../domain';
import { IPricingRepositoryPort, PRICING_REPOSITORY } from '../ports';

// Attach a TaxCategory to a variant (`catalog.variant.set-tax-category`). Points a
// variant at one tax category by writing the `product_variant.tax_category_id` FK.
//
// The FK lives on a catalog-owned table, but the link is a pricing concern, so the
// write goes through the repository's PARAMETERIZED query — pricing never imports
// the catalog `ProductVariant` (ADR-026 §5). Both existence checks happen here, in
// the application layer, so a missing variant or category surfaces as a typed
// `VARIANT_NOT_FOUND` / `TAX_CATEGORY_NOT_FOUND` (→ 404) rather than a raw FK
// driver error. No event: re-classifying a variant is an operator edit, not a
// business fact other services subscribe to.
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

    // Resolve the category by code — the caller references it by its stable code,
    // not its surrogate id. A miss is a 404, not a silent no-op.
    const taxCategory = await this.repository.findTaxCategoryByCode(taxCategoryCode);
    if (taxCategory === null) {
      throw new PricingDomainException(
        PricingErrorCodeEnum.TAX_CATEGORY_NOT_FOUND,
        `No tax category exists with code "${taxCategoryCode}".`,
      );
    }

    // The variant must exist before we write its FK — the parameterized UPDATE
    // would otherwise silently affect zero rows. The header read doubles as the
    // existence check.
    const before = await this.repository.findVariantTaxHeader(variantId);
    if (before === null) {
      throw new PricingDomainException(
        PricingErrorCodeEnum.VARIANT_NOT_FOUND,
        `No variant exists with id ${variantId}.`,
      );
    }

    // `taxCategory.id` is non-null here — it came back from the repository, which
    // assigns the concrete id (the `id!` convention the view factories use).
    await this.repository.attachTaxCategoryToVariant(variantId, taxCategory.id!);

    // Re-read so the returned header carries the now-attached category, freshly
    // resolved from storage rather than assembled from the inputs.
    const after = await this.repository.findVariantTaxHeader(variantId);
    if (after === null) {
      // The row was just updated, so a miss here is an invariant breach.
      throw new Error(
        `AttachTaxCategoryToVariantUseCase: variant ${variantId} vanished after attach`,
      );
    }

    this.logger.info(
      { correlationId, variantId, taxCategoryId: after.taxCategoryId, code: after.taxCategoryCode },
      'Variant tax category set',
    );

    return {
      variantId: after.variantId,
      sku: after.sku,
      taxCategoryId: after.taxCategoryId,
      taxCategoryCode: after.taxCategoryCode,
    };
  }
}
