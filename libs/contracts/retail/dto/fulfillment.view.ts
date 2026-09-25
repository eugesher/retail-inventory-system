import { ApiResponseProperty } from '@nestjs/swagger';

import { FulfillmentStatusEnum } from '../enums';

export class FulfillmentLineView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public orderLineId: number;

  @ApiResponseProperty()
  public quantity: number;
}

export class FulfillmentView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public orderId: number;

  @ApiResponseProperty()
  public stockLocationId: string;

  @ApiResponseProperty()
  public status: FulfillmentStatusEnum;

  @ApiResponseProperty()
  public trackingNumber: string | null;

  @ApiResponseProperty()
  public carrier: string | null;

  @ApiResponseProperty()
  public shippedAt: string | null;

  @ApiResponseProperty()
  public deliveredAt: string | null;

  @ApiResponseProperty({ type: [FulfillmentLineView] })
  public lines: FulfillmentLineView[];

  @ApiResponseProperty()
  public version: number;

  @ApiResponseProperty()
  public createdAt: string | null;

  @ApiResponseProperty()
  public updatedAt: string | null;
}
