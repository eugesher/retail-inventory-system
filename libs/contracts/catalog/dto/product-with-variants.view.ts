import { ApiResponseProperty } from '@nestjs/swagger';

import { ProductVariantView } from './product-variant.view';
import { ProductView } from './product.view';

// RPC response shape for the read path that returns a product together with its
// variants — `catalog.product.list` items and the `catalog.product.get`
// response. Extends `ProductView` (the product header, reused from the write
// path) with the variant collection.
//
// `variants` carries the product's **active** variants only: the read model
// surfaces what is sellable, so an archived variant is filtered out here even
// though it stays resolvable on its own via `catalog.variant.get` (ADR-025).
export class ProductWithVariantsView extends ProductView {
  @ApiResponseProperty({ type: [ProductVariantView] })
  public variants: ProductVariantView[];
}
