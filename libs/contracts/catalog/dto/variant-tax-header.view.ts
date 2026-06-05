import { ApiResponseProperty } from '@nestjs/swagger';

// RPC response shape for `catalog.variant.set-tax-category` — the "updated variant
// header" the attach command returns. It is the minimal projection of a variant's
// tax classification *after* the FK write: the variant's identity (`variantId`,
// `sku`) plus the now-attached category (`taxCategoryId` + `taxCategoryCode`, both
// `null` when the variant is unclassified).
//
// A **class** carrying `@ApiResponseProperty` (not a plain interface) so the
// gateway can declare it as `@ApiOkResponse({ type: VariantTaxHeaderView })` — the
// same lib-contracts response-view convention as `PriceView` / `TaxCategoryView`.
// It is deliberately NOT the full variant view: pricing reads only the columns it
// needs through a parameterized query (no catalog entity import, ADR-026 §5).
export class VariantTaxHeaderView {
  @ApiResponseProperty()
  public variantId: number;

  @ApiResponseProperty()
  public sku: string;

  @ApiResponseProperty()
  public taxCategoryId: number | null;

  @ApiResponseProperty()
  public taxCategoryCode: string | null;
}
