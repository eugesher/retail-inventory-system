import { ApiResponseProperty } from '@nestjs/swagger';

import { FulfillmentStatusEnum } from '../enums';

// One fulfillment line: how much of an `OrderLine` is in *this* shipment.
//
// `quantity` is the shipped-here amount, **not** the line's ordered amount. A partial shipment
// carries fewer units and the remainder goes out in a separate fulfillment, so summing this field
// across an order's fulfillments — not reading any one of them — is what tells you what shipped.
export class FulfillmentLineView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public orderLineId: number;

  @ApiResponseProperty()
  public quantity: number;
}

// RPC/HTTP response shape for a whole fulfillment — a per-shipment, per-location
// record that drives an order from `pending`/`authorized` toward `delivered`
// (ADR-031). A **class** carrying `@ApiResponseProperty` (the documented
// lib-contracts Swagger exception, ADR-017), mirroring `OrderView` / `PaymentView`.
//
// `stockLocationId` is the opaque inventory `stock_location` PK the shipment ships
// from (retail never imports inventory — the id is a cross-service string).
// `status` is the fulfillment's own (fourth) status axis (`FulfillmentStatusEnum`).
// `trackingNumber` / `carrier` are null until the ship operation stamps them;
// `shippedAt` / `deliveredAt` are null until the ship / deliver operations stamp
// them. `version` is the per-shipment optimistic-concurrency token (the cross-cutting
// "Concurrency & consistency" rule). `lines` are the per-`OrderLine` quantities in
// this shipment.
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
