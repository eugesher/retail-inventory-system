import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CategoryReparentView, IReparentCategoryPayload } from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum, Category } from '../../domain';
import { CATEGORY_REPOSITORY, ICategoryRepositoryPort } from '../ports';
import { toCategoryView } from './category-view.factory';

@Injectable()
export class ReparentCategoryUseCase {
  constructor(
    @Inject(CATEGORY_REPOSITORY)
    private readonly repository: ICategoryRepositoryPort,
    @InjectPinoLogger(ReparentCategoryUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: IReparentCategoryPayload): Promise<CategoryReparentView> {
    const { slug, newParentSlug, correlationId } = payload;

    this.logger.info({ correlationId, slug, newParentSlug }, 'Received RPC: reparent category');

    const category = await this.repository.findBySlug(slug);
    if (category === null) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.CATEGORY_NOT_FOUND,
        `Category "${slug}" not found`,
      );
    }

    let newParent: Category | null = null;
    if (newParentSlug !== undefined && newParentSlug !== null) {
      newParent = await this.repository.findBySlug(newParentSlug);
      if (newParent === null) {
        throw new CatalogDomainException(
          CatalogErrorCodeEnum.CATEGORY_PARENT_NOT_FOUND,
          `Parent category "${newParentSlug}" not found`,
        );
      }
      if (newParent.isArchived()) {
        throw new CatalogDomainException(
          CatalogErrorCodeEnum.CATEGORY_ARCHIVED,
          `Parent category "${newParentSlug}" is archived; cannot reparent a subtree under a hidden one`,
        );
      }
    }

    const oldPath = category.path;
    category.reparentUnder(newParent);

    const rewrittenDescendantCount = await this.repository.reparentSubtree(category, oldPath);

    this.logger.info(
      {
        correlationId,
        categoryId: category.id,
        oldPath,
        newPath: category.path,
        rewrittenDescendantCount,
      },
      'Category reparented',
    );

    return { category: toCategoryView(category), rewrittenDescendantCount };
  }
}
