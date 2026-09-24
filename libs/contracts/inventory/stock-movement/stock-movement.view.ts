import { ApiResponseProperty } from '@nestjs/swagger';

import { StockMovementTypeEnum } from '../enums';

export class StockMovementView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public variantId: number;

  @ApiResponseProperty()
  public stockLocationId: string;

  @ApiResponseProperty()
  public type: StockMovementTypeEnum;

  @ApiResponseProperty()
  public quantity: number;

  @ApiResponseProperty()
  public reasonCode: string | null;

  @ApiResponseProperty()
  public referenceType: string | null;

  @ApiResponseProperty()
  public referenceId: string | null;

  @ApiResponseProperty()
  public actorId: string | null;

  @ApiResponseProperty()
  public occurredAt: string;
}
