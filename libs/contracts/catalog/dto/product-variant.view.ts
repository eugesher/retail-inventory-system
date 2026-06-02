import { ApiResponseProperty } from '@nestjs/swagger';

export class VariantDimensionsView {
  @ApiResponseProperty()
  public l: number;

  @ApiResponseProperty()
  public w: number;

  @ApiResponseProperty()
  public h: number;
}

// RPC response shape for `catalog.variant.create` — the persisted variant after
// it is appended to its product. `gtin`, `weightG`, and `dimensionsMm` are
// nullable (absent on a variant that omits them). `optionValues` is the raw
// option map. `status` is the variant lifecycle string (`active`/`archived`).
export class ProductVariantView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public productId: number;

  @ApiResponseProperty()
  public sku: string;

  @ApiResponseProperty()
  public gtin: string | null;

  @ApiResponseProperty()
  public optionValues: Record<string, string>;

  @ApiResponseProperty()
  public weightG: number | null;

  @ApiResponseProperty({ type: VariantDimensionsView })
  public dimensionsMm: VariantDimensionsView | null;

  @ApiResponseProperty()
  public status: string;
}
