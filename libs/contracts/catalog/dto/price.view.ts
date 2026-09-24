import { ApiResponseProperty } from '@nestjs/swagger';

export class PriceView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public variantId: number;

  @ApiResponseProperty()
  public currency: string;

  @ApiResponseProperty()
  public amountMinor: number;

  @ApiResponseProperty()
  public validFrom: string;

  @ApiResponseProperty()
  public validTo: string | null;

  @ApiResponseProperty()
  public priority: number;
}
