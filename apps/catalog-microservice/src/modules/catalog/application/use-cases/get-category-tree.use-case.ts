import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { CategoryTreeNodeView, ICategoryTreeQuery } from '@retail-inventory-system/contracts';

import { CatalogDomainException, CatalogErrorCodeEnum, Category } from '../../domain';
import { CATEGORY_REPOSITORY, ICategoryRepositoryPort } from '../ports';
import { toCategoryTreeNode } from './category-view.factory';

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

    const nodes = await this.repository.listSubtree(root.path, { activeOnly: true });

    return assembleCategoryTree(root, nodes);
  }
}
