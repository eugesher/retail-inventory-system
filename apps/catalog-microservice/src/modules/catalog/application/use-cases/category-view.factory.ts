import { CategoryView } from '@retail-inventory-system/contracts';

import { Category } from '../../domain';

// Pure mapping from the `Category` domain aggregate onto the wire `CategoryView`.
// Kept framework-free (no Nest decorators) and shared across every category use
// case (create returns it directly; reparent nests it inside `CategoryReparentView`),
// so the projection lives in exactly one place — the `catalog-view.factory.ts`
// pattern.
//
// The aggregate is always persisted when it reaches the factory (the use cases
// map only post-`save`/post-`findBySlug` aggregates), so `id` is concrete — the
// `!` reflects that invariant. `status` is the `CategoryStatusEnum` value, whose
// raw string (`active`/`archived`) is exactly the wire representation.
export const toCategoryView = (category: Category): CategoryView => ({
  id: category.id!,
  name: category.name,
  slug: category.slug,
  parentId: category.parentId,
  path: category.path,
  sortOrder: category.sortOrder,
  status: category.status,
});
