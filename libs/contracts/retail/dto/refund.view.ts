import { ApiResponseProperty } from '@nestjs/swagger';

import { RefundStatusEnum } from '../enums';

export class RefundView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public orderId: number;

  @ApiResponseProperty()
  public paymentId: number;

  @ApiResponseProperty()
  public amountMinor: number;

  @ApiResponseProperty()
  public currency: string;

  @ApiResponseProperty()
  public status: RefundStatusEnum;

  @ApiResponseProperty()
  public reason: string;

  @ApiResponseProperty()
  public gatewayReference: string | null;

  @ApiResponseProperty()
  public issuedAt: string | null;

  @ApiResponseProperty()
  public createdAt: string;

  @ApiResponseProperty()
  public updatedAt: string;
}
