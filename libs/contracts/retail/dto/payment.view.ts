import { ApiResponseProperty } from '@nestjs/swagger';

import { PaymentStatusEnum } from '../enums';

// RPC/HTTP response shape for one payment row. A **class** carrying
// `@ApiResponseProperty` (the documented lib-contracts Swagger exception, ADR-017),
// mirroring `OrderView` / `CartView` / `PriceView`.
//
// A payment is the record of a single gateway interaction for an order. `method`
// and `gatewayReference` are **opaque tokens** the gateway returns (a real adapter
// would echo a processor's card/charge ids; the in-process fake returns
// deterministic stand-ins) — retail stores them but never parses them. `amountMinor`
// is an integer count of minor units (cents), never a float. `authorizedAt` is
// stamped when the authorize succeeds; `capturedAt` stays `null` until an explicit
// capture, so a not-yet-captured payment surfaces `status='authorized'` with a null
// `capturedAt`. It surfaces on `OrderView.payment` once an order has a payment.
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
