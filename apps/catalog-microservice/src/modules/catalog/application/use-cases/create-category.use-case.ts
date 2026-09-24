import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CategoryView, ICreateCategoryPayload } from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum, Category } from '../../domain';
import { CATEGORY_REPOSITORY, ICategoryRepositoryPort } from '../ports';
import { toCategoryView } from './category-view.factory';

@Injectable()
export class CreateCategoryUseCase {
  constructor(
    @Inject(CATEGORY_REPOSITORY)
    private readonly repository: ICategoryRepositoryPort,
    @InjectPinoLogger(CreateCategoryUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: ICreateCategoryPayload): Promise<CategoryView> {
    const { name, slug, parentSlug, sortOrder, correlationId } = payload;

    this.logger.info({ correlationId, slug, parentSlug }, 'Received RPC: create category');

    if (await this.repository.existsBySlug(slug)) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.CATEGORY_SLUG_TAKEN,
        `Category slug "${slug}" is already taken`,
      );
    }

    let parent: Category | null = null;
    if (parentSlug !== undefined) {
      parent = await this.repository.findBySlug(parentSlug);
      if (parent === null) {
        throw new CatalogDomainException(
          CatalogErrorCodeEnum.CATEGORY_PARENT_NOT_FOUND,
          `Parent category "${parentSlug}" not found`,
        );
      }
      if (parent.isArchived()) {
        throw new CatalogDomainException(
          CatalogErrorCodeEnum.CATEGORY_ARCHIVED,
          `Parent category "${parentSlug}" is archived; cannot add a child to a hidden subtree`,
        );
      }
    }

    const category = Category.create({ name, slug, parent, sortOrder });

    const saved = await this.repository.save(category);
    if (saved.id === null) {
      throw new Error('CreateCategoryUseCase: repository returned an unsaved aggregate');
    }

    this.logger.info({ correlationId, categoryId: saved.id, path: saved.path }, 'Category created');

    return toCategoryView(saved);
  }
}
