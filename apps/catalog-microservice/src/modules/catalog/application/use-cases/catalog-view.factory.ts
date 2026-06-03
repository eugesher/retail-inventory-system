import {
  ProductVariantView,
  ProductView,
  ProductWithVariantsView,
} from '@retail-inventory-system/contracts';

import { Product, ProductVariant } from '../../domain';

// Pure mapping functions from the catalog domain onto the wire views. Kept
// framework-free (no Nest decorators) and shared across both the read use cases
// (the composite product + variants / variant + product shapes) and the write
// use cases (which return the plain `ProductView` / `ProductVariantView` header,
// with publish/archive spreading in their lifecycle timestamp), so each
// projection lives in exactly one place.

// Product header — the shape reused by the write `ProductView` and as the base
// of the composite read views. The lifecycle-transition timestamps
// (`publishedAt` / `archivedAt`) are write-path concerns and are left unset on
// the read path.
export const toProductView = (product: Product): ProductView => ({
  id: product.id!,
  name: product.name,
  slug: product.slug,
  description: product.description,
  status: product.status,
});

export const toProductVariantView = (variant: ProductVariant): ProductVariantView => ({
  id: variant.id!,
  productId: variant.productId!,
  sku: variant.sku,
  gtin: variant.gtin,
  optionValues: variant.optionValues,
  weightG: variant.weightG,
  dimensionsMm: variant.dimensionsMm,
  status: variant.status,
});

// Product + its **active** variants. The read model surfaces what is sellable,
// so archived variants are filtered out (an archived variant stays resolvable on
// its own via `catalog.variant.get` — ADR-025).
export const toProductWithVariantsView = (product: Product): ProductWithVariantsView => ({
  ...toProductView(product),
  variants: product.variants
    .filter((variant) => variant.isActive())
    .map((variant) => toProductVariantView(variant)),
});
