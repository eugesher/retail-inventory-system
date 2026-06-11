import { ApiResponseProperty } from '@nestjs/swagger';

import { CategoryView } from './category.view';

// RPC response shape for `catalog.category.reparent`. Reparenting is two writes
// in one transaction — the moved category's own row plus a bulk rebase of every
// descendant's `path` — so the response surfaces both halves: the moved
// `category` in its new position and `rewrittenDescendantCount`, the number of
// descendant rows whose `path` the rebase rewrote (0 when the moved node is a
// leaf). The count is the repository's `reparentSubtree` return value, threaded
// through unchanged (ADR-029 §2).
export class CategoryReparentView {
  @ApiResponseProperty({ type: CategoryView })
  public category: CategoryView;

  @ApiResponseProperty()
  public rewrittenDescendantCount: number;
}
