import { ApiResponseProperty } from '@nestjs/swagger';

class ProductStockStockItemDto {
  @ApiResponseProperty()
  public storageId: string;

  @ApiResponseProperty()
  public quantity: number;

  @ApiResponseProperty()
  public updatedAt: Date;
}

export class ProductStockDto {
  @ApiResponseProperty()
  public productId: number;

  @ApiResponseProperty()
  public quantity: number;

  @ApiResponseProperty()
  public updatedAt: Date | null;

  @ApiResponseProperty({
    type: [ProductStockStockItemDto],
  })
  public items: ProductStockStockItemDto[];
}
