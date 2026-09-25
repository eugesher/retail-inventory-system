import { ApiResponseProperty } from '@nestjs/swagger';

export class StockLocationView {
  @ApiResponseProperty()
  public id: string;

  @ApiResponseProperty()
  public name: string;

  @ApiResponseProperty()
  public code: string;

  @ApiResponseProperty()
  public type: string;

  @ApiResponseProperty()
  public gln: string | null;

  @ApiResponseProperty()
  public active: boolean;
}
