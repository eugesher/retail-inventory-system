import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { clampPageWindow } from '@retail-inventory-system/common';
import {
  ICategoryProductsQuery,
  IPage,
  ProductWithVariantsView,
} from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum } from '../../domain';
import {
  CATALOG_REPOSITORY,
  CATEGORY_REPOSITORY,
  ICatalogRepositoryPort,
  ICategoryRepositoryPort,
} from '../ports';
import { toProductWithVariantsView } from './catalog-view.factory';

@Injectable()
export class ListCategoryProductsUseCase {
  constructor(
    @Inject(CATALOG_REPOSITORY)
    private readonly catalogRepository: ICatalogRepositoryPort,
    @Inject(CATEGORY_REPOSITORY)
    private readonly categoryRepository: ICategoryRepositoryPort,
    @InjectPinoLogger(ListCategoryProductsUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(query: ICategoryProductsQuery): Promise<IPage<ProductWithVariantsView>> {
    const { slug, includeDescendants, correlationId } = query;

    const { page, size } = clampPageWindow(query.page, query.pageSize);

    this.logger.info(
      { correlationId, slug, includeDescendants: includeDescendants ?? false, page, size },
      'Received RPC: list category products',
    );

    const category = await this.categoryRepository.findBySlug(slug);
    if (category === null || category.isArchived()) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.CATEGORY_NOT_FOUND,
        `Category "${slug}" not found`,
      );
    }

    const categoryIds = new Set<number>();
    if (category.id !== null) {
      categoryIds.add(category.id);
    }
    if (includeDescendants) {
      const subtree = await this.categoryRepository.listSubtree(category.path, {
        activeOnly: true,
      });
      for (const node of subtree) {
        if (node.id !== null) {
          categoryIds.add(node.id);
        }
      }
    }

    const result = await this.catalogRepository.listActiveByCategoryIds({
      categoryIds: [...categoryIds],
      page,
      size,
    });

    return {
      ...result,
      items: result.items.map((product) => toProductWithVariantsView(product)),
    };
  }
}
