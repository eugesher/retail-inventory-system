import { ApiResponseProperty } from '@nestjs/swagger';

import { CategoryView } from './category.view';
import { ProductView } from './product.view';

export class ProductCategoriesView {
  @ApiResponseProperty({ type: ProductView })
  public product: ProductView;

  @ApiResponseProperty({ type: [CategoryView] })
  public categories: CategoryView[];
}
