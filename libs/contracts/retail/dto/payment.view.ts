import { ApiResponseProperty } from '@nestjs/swagger';

import { PaymentStatusEnum } from '../enums';

export class PaymentView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public orderId: number;

  @ApiResponseProperty()
  public amountMinor: number;

  @ApiResponseProperty()
  public currency: string;

  @ApiResponseProperty()
  public method: string;

  @ApiResponseProperty()
  public status: PaymentStatusEnum;

  @ApiResponseProperty()
  public gatewayReference: string;

  @ApiResponseProperty()
  public authorizedAt: string | null;

  @ApiResponseProperty()
  public capturedAt: string | null;
}
