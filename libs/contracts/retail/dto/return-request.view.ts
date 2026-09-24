import { ApiResponseProperty } from '@nestjs/swagger';

import {
  ReturnDispositionEnum,
  ReturnLineConditionEnum,
  ReturnReasonCategoryEnum,
  ReturnStatusEnum,
} from '../enums';

export class ReturnLineView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public orderLineId: number;

  @ApiResponseProperty()
  public quantity: number;

  @ApiResponseProperty()
  public condition: ReturnLineConditionEnum | null;

  @ApiResponseProperty()
  public disposition: ReturnDispositionEnum | null;

  @ApiResponseProperty()
  public lineRefundAmountMinor: number | null;
}

export class ReturnRequestView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public rmaNumber: string | null;

  @ApiResponseProperty()
  public orderId: number;

  @ApiResponseProperty()
  public customerId: string;

  @ApiResponseProperty()
  public status: ReturnStatusEnum;

  @ApiResponseProperty()
  public reasonCategory: ReturnReasonCategoryEnum;

  @ApiResponseProperty()
  public notes: string | null;

  @ApiResponseProperty()
  public requestedAt: string;

  @ApiResponseProperty()
  public authorizedAt: string | null;

  @ApiResponseProperty()
  public closedAt: string | null;

  @ApiResponseProperty({ type: [ReturnLineView] })
  public lines: ReturnLineView[];

  @ApiResponseProperty()
  public version: number;

  @ApiResponseProperty()
  public createdAt: string | null;

  @ApiResponseProperty()
  public updatedAt: string | null;
}
