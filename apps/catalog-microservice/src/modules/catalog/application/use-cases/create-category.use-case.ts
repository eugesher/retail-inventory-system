import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CategoryView, ICreateCategoryPayload } from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum, Category } from '../../domain';
import { CATEGORY_REPOSITORY, ICategoryRepositoryPort } from '../ports';
import { toCategoryView } from './category-view.factory';

// Create Category is the first category write operation: it inserts an `active`
// category, either as a root (no `parentSlug`) or hanging off an existing parent.
// The materialized `path` is derived by the domain (`Category.create`) from the
// loaded parent — so the parent must be resolved to a row first. Records NO event
// (the category capability emits none — ADR-029 §6).
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

    // Repository-level uniqueness pre-check: the domain cannot see other
    // aggregates, so a duplicate slug is rejected here with a typed code before
    // the INSERT would otherwise trip the UNIQUE constraint with a raw driver
    // error (ADR-025). The UNIQUE constraint stays the hard guard.
    if (await this.repository.existsBySlug(slug)) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.CATEGORY_SLUG_TAKEN,
        `Category slug "${slug}" is already taken`,
      );
    }

    // Resolve the parent when one was named. A missing parent is a 404; an
    // archived parent is a 409 — a new child must not extend a hidden subtree
    // (the descendant would be live under an archived ancestor).
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

    // Build — the aggregate derives `parentId` + `path` from the parent (root
    // when null) and enforces the name/slug/sort-order invariants, throwing a
    // typed `CatalogDomainException` on a violation.
    const category = Category.create({ name, slug, parent, sortOrder });

    const saved = await this.repository.save(category);
    if (saved.id === null) {
      throw new Error('CreateCategoryUseCase: repository returned an unsaved aggregate');
    }

    this.logger.info({ correlationId, categoryId: saved.id, path: saved.path }, 'Category created');

    return toCategoryView(saved);
  }
}
