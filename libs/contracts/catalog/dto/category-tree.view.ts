import { ApiResponseProperty } from '@nestjs/swagger';

import { CategoryView } from './category.view';

// RPC response shape for `catalog.category.get-tree` — a category together with
// its **active** subtree, assembled into a nested structure. Extends the flat
// `CategoryView` (the same id/name/slug/parentId/path/sortOrder/status header the
// write path returns) and adds the recursive `children` collection, so the
// gateway renders a tree without a second round of assembly.
//
// `children` is SELF-REFERENTIAL. `@ApiResponseProperty({ type: () => [CategoryTreeNodeView] })`
// uses the THUNK form (`() => ...`): a bare `type: [CategoryTreeNodeView]` would
// read the class before its own declaration finishes and resolve to `undefined`,
// so Swagger needs the lazy reference to tolerate the recursion. A leaf node
// carries an empty `children` array, never `undefined`.
export class CategoryTreeNodeView extends CategoryView {
  @ApiResponseProperty({ type: () => [CategoryTreeNodeView] })
  public children: CategoryTreeNodeView[];
}
