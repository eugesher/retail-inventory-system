import { ApiResponseProperty } from '@nestjs/swagger';

export class CategoryView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public name: string;

  @ApiResponseProperty()
  public slug: string;

  @ApiResponseProperty()
  public parentId: number | null;

  @ApiResponseProperty()
  public path: string;

  @ApiResponseProperty()
  public sortOrder: number;

  @ApiResponseProperty()
  public status: string;
}
