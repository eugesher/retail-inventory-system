import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICreateTaxCategoryPayload, TaxCategoryView } from '@retail-inventory-system/contracts';

import { PricingDomainException, PricingErrorCodeEnum, TaxCategory } from '../../domain';
import { IPricingRepositoryPort, PRICING_REPOSITORY } from '../ports';
import { toTaxCategoryView } from './tax-category-view.factory';

// Create TaxCategory (`catalog.tax-category.create`). A tax category is a
// classification label only — no rate or jurisdiction (ADR-026). The use case
// builds the domain model (which validates the UPPER_SNAKE_CASE `code` and the
// non-empty `name`), pre-checks `code` uniqueness against the repository, then
// persists. No event: a label set is static reference data, not a business event
// other services react to.
//
// `code` uniqueness is a two-layer guard (ADR-026 §6): the `findTaxCategoryByCode`
// pre-check here raises a clean typed `TAX_CATEGORY_CODE_TAKEN`, and the
// `UC_TAX_CATEGORY_CODE` UNIQUE constraint is the hard backstop if two creates
// race past the pre-check (the driver error would still surface — the pre-check
// just makes the common case a tidy domain rejection rather than a 500).
@Injectable()
export class CreateTaxCategoryUseCase {
  constructor(
    @Inject(PRICING_REPOSITORY)
    private readonly repository: IPricingRepositoryPort,
    @InjectPinoLogger(CreateTaxCategoryUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: ICreateTaxCategoryPayload): Promise<TaxCategoryView> {
    const { code, name, description, correlationId } = payload;

    this.logger.info({ correlationId, code }, 'Received RPC: create tax category');

    // Build first: the domain rejects a malformed `code` / blank `name` before we
    // touch the repository (a bad payload should never reach the uniqueness check).
    const taxCategory = TaxCategory.create({ code, name, description });

    const existing = await this.repository.findTaxCategoryByCode(taxCategory.code);
    if (existing !== null) {
      throw new PricingDomainException(
        PricingErrorCodeEnum.TAX_CATEGORY_CODE_TAKEN,
        `A tax category with code "${taxCategory.code}" already exists.`,
      );
    }

    const saved = await this.repository.createTaxCategory(taxCategory);

    this.logger.info(
      { correlationId, code: saved.code, taxCategoryId: saved.id },
      'Tax category created',
    );

    return toTaxCategoryView(saved);
  }
}
