import { ApiResponseProperty } from '@nestjs/swagger';

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
