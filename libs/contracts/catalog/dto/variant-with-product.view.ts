import { ApiResponseProperty } from '@nestjs/swagger';

import { ProductVariantView } from './product-variant.view';
import { ProductView } from './product.view';

// RPC response shape for `catalog.variant.get` — a single variant plus its
// parent product header. Extends `ProductVariantView` (reused from the write
// path) with the owning `product`.
//
// Unlike the list/by-slug views, no status filtering applies: an archived
// variant (and an archived parent product) stays resolvable here so historical
// order/stock references that key on `variantId` never dangle (ADR-025).
export class VariantWithProductView extends ProductVariantView {
  @ApiResponseProperty({ type: ProductView })
  public product: ProductView;
}
