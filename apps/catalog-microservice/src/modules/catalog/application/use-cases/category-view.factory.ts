import { CategoryTreeNodeView, CategoryView } from '@retail-inventory-system/contracts';

import { Category } from '../../domain';

export const toCategoryView = (category: Category): CategoryView => ({
  id: category.id!,
  name: category.name,
  slug: category.slug,
  parentId: category.parentId,
  path: category.path,
  sortOrder: category.sortOrder,
  status: category.status,
});

export const toCategoryTreeNode = (
  category: Category,
  children: CategoryTreeNodeView[],
): CategoryTreeNodeView => ({
  ...toCategoryView(category),
  children,
});
