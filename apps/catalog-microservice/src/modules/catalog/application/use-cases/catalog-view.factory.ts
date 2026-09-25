import {
  ProductVariantView,
  ProductView,
  ProductWithVariantsView,
} from '@retail-inventory-system/contracts';

import { Product, ProductVariant } from '../../domain';

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

export const toProductWithVariantsView = (product: Product): ProductWithVariantsView => ({
  ...toProductView(product),
  variants: product.variants
    .filter((variant) => variant.isActive())
    .map((variant) => toProductVariantView(variant)),
});
