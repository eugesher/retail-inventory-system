import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CategoryReparentView, IReparentCategoryPayload } from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum, Category } from '../../domain';
import { CATEGORY_REPOSITORY, ICategoryRepositoryPort } from '../ports';
import { toCategoryView } from './category-view.factory';

// Reparent Category moves a category (and, implicitly, its whole subtree) under a
// new parent — or demotes it to a root when no new parent is named. The work is
// split across two layers (ADR-029 §2):
//   - the domain (`Category.reparentUnder`) recomputes the moved node's OWN
//     `parentId` + `path` and rejects a cycle (you cannot move a category under
//     itself or one of its descendants);
//   - the repository (`reparentSubtree`) rebases every descendant's `path` in
//     one transaction and returns how many rows it rewrote.
// The use case is the orchestrator: it snapshots `oldPath` BEFORE mutating, so the
// repository can match the old subtree prefix; mutating first would lose it.
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

    // Resolve the destination parent. `null`/omitted demotes the category to a
    // root; a named parent is resolved by slug — a miss is a 404, an archived
    // parent a 409 (a live subtree must not be moved under a hidden one).
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

    // Snapshot the old path BEFORE the recompute — the repository rebases every
    // descendant whose path starts with `oldPath + '/'`, so it must be captured
    // while the aggregate still carries the pre-move path. `reparentUnder`
    // recomputes own `parentId` + `path` and throws `CATEGORY_CYCLE` when the
    // target is the category itself or one of its descendants. Reparenting to the
    // CURRENT parent is an idempotent success — the path recomputes to the same
    // value and the cycle test does not fire (the node is not its own descendant),
    // so it is deliberately not special-cased into an error.
    const oldPath = category.path;
    category.reparentUnder(newParent);

    // One-transaction rebase: the moved-row UPDATE + the bulk descendant rebase.
    // Returns the number of descendant rows whose `path` was rewritten (0 for a
    // leaf). The moved aggregate already carries its recomputed `parentId`/`path`,
    // so mapping it directly reflects the persisted state.
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
