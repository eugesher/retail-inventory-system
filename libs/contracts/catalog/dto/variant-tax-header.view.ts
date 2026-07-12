import { ApiResponseProperty } from '@nestjs/swagger';

// The minimal projection of a variant's tax classification after the FK write — `taxCategoryId`
// and `taxCategoryCode` are both `null` when the variant is unclassified.
//
// Deliberately **not** the full variant view. Pricing may not import a catalog entity, so it
// reads exactly the columns it needs through a parameterized query (ADR-026 §5); widening this
// view would tempt the shortcut the rule exists to prevent.
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
