import { ApiResponseProperty } from '@nestjs/swagger';

import { RefundStatusEnum } from '../enums';

// RPC/HTTP response shape for one refund row. A **class** carrying
// `@ApiResponseProperty` (the documented lib-contracts Swagger exception, ADR-017),
// mirroring `PaymentView` / `OrderView` / `CartView`.
//
// A refund is the record of one gateway refund interaction against a captured
// `payment`. `gatewayReference` is the **opaque token** the gateway returns when the
// refund issues (a real adapter would echo a processor's refund id; the in-process
// fake returns a deterministic stand-in) — retail stores it but never parses it, and
// it stays `null` while the refund is `pending`. `amountMinor` is an integer count of
// minor units (cents), never a float. `issuedAt` stays `null` until the gateway
// confirms the refund, so a pending refund surfaces `status='pending'` with a null
// `gatewayReference` / `issuedAt`. A `Refund` is a sibling of `Payment` — its `orderId`
// / `paymentId` pin the order it refunds and the payment it reverses.
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
