import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ICorrelationPayload, TaxCategoryView } from '@retail-inventory-system/contracts';

import { IPricingRepositoryPort, PRICING_REPOSITORY } from '../ports';
import { toTaxCategoryView } from './tax-category-view.factory';

// List TaxCategories (`catalog.tax-category.list`). The full label set, mapped to
// `TaxCategoryView[]`. There is no paging or filtering: a tax-category set is a
// small, static piece of reference data (a handful of rows — "standard",
// "reduced", "zero-rated", "exempt"), so the whole list is returned in one shot
// (the repository orders it by `code` for a stable presentation). The query
// carries only a `correlationId` (`ICorrelationPayload`) — there is nothing to
// scope by. No event.
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
