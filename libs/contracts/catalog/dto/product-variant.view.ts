import { ApiResponseProperty } from '@nestjs/swagger';

export class VariantDimensionsView {
  @ApiResponseProperty()
  public l: number;

  @ApiResponseProperty()
  public w: number;

  @ApiResponseProperty()
  public h: number;
}

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
