import { ApiResponseProperty } from '@nestjs/swagger';

export class StockLevelView {
  @ApiResponseProperty()
  public stockLocationId: string;

  @ApiResponseProperty()
  public quantityOnHand: number;

  @ApiResponseProperty()
  public quantityAllocated: number;

  @ApiResponseProperty()
  public quantityReserved: number;

  @ApiResponseProperty()
  public available: number;

  @ApiResponseProperty()
  public version: number;

  @ApiResponseProperty()
  public updatedAt: Date | null;
}
