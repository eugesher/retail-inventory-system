import { ApiResponseProperty } from '@nestjs/swagger';

import { CategoryView } from './category.view';
import { ProductView } from './product.view';

// RPC response shape for `catalog.product.reclassify` — the updated product
// header plus its FULL current category membership after the attach/detach was
// applied. `categories` is the post-operation truth (re-read from
// `product_categories`, not a diff of what changed), so a caller sees exactly
// what the product now belongs to. An empty array means the product is in no
// category (every membership was detached).
export class ProductCategoriesView {
  @ApiResponseProperty({ type: ProductView })
  public product: ProductView;

  @ApiResponseProperty({ type: [CategoryView] })
  public categories: CategoryView[];
}
