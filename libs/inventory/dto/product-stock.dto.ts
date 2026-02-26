import { ApiResponseProperty } from '@nestjs/swagger';

class ProductStockStockItemDto {
  @ApiResponseProperty()
  public storeId: string;

  @ApiResponseProperty()
  public quantity: number;

  @ApiResponseProperty()
  public updatedAt: Date;
}

export class ProductStockDto {
  @ApiResponseProperty()
  public productId: string;

  @ApiResponseProperty()
  public quantity: number;

  @ApiResponseProperty()
  public updatedAt: Date;

  @ApiResponseProperty({
    type: [ProductStockStockItemDto],
  })
  public items: ProductStockStockItemDto[];
}
