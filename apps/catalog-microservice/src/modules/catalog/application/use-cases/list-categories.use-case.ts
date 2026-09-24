import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CategoryView, ICategoryListQuery } from '@retail-inventory-system/contracts';

import { CATEGORY_REPOSITORY, ICategoryRepositoryPort } from '../ports';
import { toCategoryView } from './category-view.factory';

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

    const categories = await this.repository.listAll({ rootOnly, activeOnly: true });

    return categories.map((category) => toCategoryView(category));
  }
}
