import { ApiResponseProperty } from '@nestjs/swagger';

import { ProductVariantView } from './product-variant.view';
import { ProductView } from './product.view';

export class ProductWithVariantsView extends ProductView {
  @ApiResponseProperty({ type: [ProductVariantView] })
  public variants: ProductVariantView[];
}
