import { ApiResponseProperty } from '@nestjs/swagger';

import { ProductVariantView } from './product-variant.view';
import { ProductView } from './product.view';

export class VariantWithProductView extends ProductVariantView {
  @ApiResponseProperty({ type: ProductView })
  public product: ProductView;
}
