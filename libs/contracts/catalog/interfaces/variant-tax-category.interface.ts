import { ICorrelationPayload } from '../../microservices';

// Wire-format command payload for `catalog.variant.set-tax-category` (API Gateway
// → Catalog) — point a variant at a tax category. The variant is addressed by its
// opaque numeric `variantId` (the downstream backbone key, ADR-025); the category
// is addressed by its stable `taxCategoryCode` rather than its surrogate id so the
// caller need not know the internal id of a label it references by code.
//
// The attach use case resolves the code to a `tax_category.id` and writes the
// `product_variant.tax_category_id` FK. An unknown code raises
// `TAX_CATEGORY_NOT_FOUND`; an unknown variant raises `VARIANT_NOT_FOUND`.
export interface IAttachVariantTaxCategoryPayload extends ICorrelationPayload {
  variantId: number;
  taxCategoryCode: string;
}
