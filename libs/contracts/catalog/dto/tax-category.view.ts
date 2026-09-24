import { ApiResponseProperty } from '@nestjs/swagger';

export class TaxCategoryView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public code: string;

  @ApiResponseProperty()
  public name: string;

  @ApiResponseProperty()
  public description: string | null;
}
