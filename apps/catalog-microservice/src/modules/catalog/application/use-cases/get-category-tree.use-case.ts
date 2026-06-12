import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CategoryTreeNodeView, ICategoryTreeQuery } from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum, Category } from '../../domain';
import { CATEGORY_REPOSITORY, ICategoryRepositoryPort } from '../ports';
import { toCategoryTreeNode } from './category-view.factory';

// Pure assembly of the flat active subtree into a nested view. The rows are
// indexed by `parentId`, then the tree is built top-down from the root. A node
// whose parent is NOT in the active set (e.g. an archived intermediate, dropped
// by `activeOnly`) never attaches — its branch is silently omitted, so an
// archived intermediate hides its whole subtree (the pragmatic browse rule,
// ADR-029 / doc 02). Siblings are ordered `sortOrder ASC, name ASC`.
const assembleCategoryTree = (root: Category, nodes: Category[]): CategoryTreeNodeView => {
  const childrenByParentId = new Map<number, Category[]>();
  for (const node of nodes) {
    if (node.parentId === null) {
      continue;
    }
    const siblings = childrenByParentId.get(node.parentId) ?? [];
    siblings.push(node);
    childrenByParentId.set(node.parentId, siblings);
  }

  const build = (category: Category): CategoryTreeNodeView => {
    const childCategories = category.id === null ? [] : (childrenByParentId.get(category.id) ?? []);
    const children = [...childCategories]
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
      .map((child) => build(child));
    return toCategoryTreeNode(category, children);
  };

  return build(root);
};

// Get Category Tree returns one category and its ACTIVE subtree as a nested
// structure (the browse navigation drill-down). The root is addressed by slug; a
// missing OR archived category is a 404 — the tree is a browse read and an
// archived category is hidden from browse. Records no event (ADR-029 §6).
@Injectable()
export class GetCategoryTreeUseCase {
  constructor(
    @Inject(CATEGORY_REPOSITORY)
    private readonly repository: ICategoryRepositoryPort,
    @InjectPinoLogger(GetCategoryTreeUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(query: ICategoryTreeQuery): Promise<CategoryTreeNodeView> {
    const { slug, correlationId } = query;

    this.logger.info({ correlationId, slug }, 'Received RPC: get category tree');

    const root = await this.repository.findBySlug(slug);
    if (root === null || root.isArchived()) {
      throw new CatalogDomainException(
        CatalogErrorCodeEnum.CATEGORY_NOT_FOUND,
        `Category "${slug}" not found`,
      );
    }

    // `listSubtree(root.path)` returns the root (self) plus its strict
    // descendants; `activeOnly` keeps only the live nodes, so the assembly above
    // drops any branch hanging off an archived intermediate.
    const nodes = await this.repository.listSubtree(root.path, { activeOnly: true });

    return assembleCategoryTree(root, nodes);
  }
}
