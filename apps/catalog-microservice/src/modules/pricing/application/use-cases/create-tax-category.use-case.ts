import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICreateTaxCategoryPayload, TaxCategoryView } from '@retail-inventory-system/contracts';

import { PricingDomainException, PricingErrorCodeEnum, TaxCategory } from '../../domain';
import { IPricingRepositoryPort, PRICING_REPOSITORY } from '../ports';
import { toTaxCategoryView } from './tax-category-view.factory';

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
