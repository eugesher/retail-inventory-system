import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICorrelationPayload, TaxCategoryView } from '@retail-inventory-system/contracts';

import { IPricingRepositoryPort, PRICING_REPOSITORY } from '../ports';
import { toTaxCategoryView } from './tax-category-view.factory';

@Injectable()
export class ListTaxCategoriesUseCase {
  constructor(
    @Inject(PRICING_REPOSITORY)
    private readonly repository: IPricingRepositoryPort,
    @InjectPinoLogger(ListTaxCategoriesUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(query: ICorrelationPayload): Promise<TaxCategoryView[]> {
    const { correlationId } = query;

    this.logger.info({ correlationId }, 'Received RPC: list tax categories');

    const categories = await this.repository.listTaxCategories();

    return categories.map(toTaxCategoryView);
  }
}
