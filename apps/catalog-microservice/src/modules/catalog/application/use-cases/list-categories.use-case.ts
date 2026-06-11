import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CategoryView, ICategoryListQuery } from '@retail-inventory-system/contracts';

import { CATEGORY_REPOSITORY, ICategoryRepositoryPort } from '../ports';
import { toCategoryView } from './category-view.factory';

// List Categories is the flat read for a store-front navigation menu: it returns
// every ACTIVE category (an archived category is hidden from browse — ADR-025),
// optionally narrowed to the roots with `rootOnly`. The repository orders the
// rows `sortOrder ASC, name ASC` (the navigation order), so the use case is a
// thin filter + projection. Records no event (the category capability emits none
// — ADR-029 §6).
@Injectable()
export class ListCategoriesUseCase {
  constructor(
    @Inject(CATEGORY_REPOSITORY)
    private readonly repository: ICategoryRepositoryPort,
    @InjectPinoLogger(ListCategoriesUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(query: ICategoryListQuery): Promise<CategoryView[]> {
    const { rootOnly, correlationId } = query;

    this.logger.info(
      { correlationId, rootOnly: rootOnly ?? false },
      'Received RPC: list categories',
    );

    // `activeOnly: true` is hard-wired — a public browse never surfaces archived
    // categories. `rootOnly` is forwarded as-is (undefined means every level).
    const categories = await this.repository.listAll({ rootOnly, activeOnly: true });

    return categories.map((category) => toCategoryView(category));
  }
}
