import { ApiResponseProperty } from '@nestjs/swagger';

import { FulfillmentStatusEnum } from '../enums';

// RPC/HTTP response shape for one fulfillment line — which `OrderLine` quantity is
// in this shipment. A **class** carrying `@ApiResponseProperty` (not a plain
// interface) so the gateway can declare it as a Swagger response type —
// `@nestjs/swagger` is the documented lib-contracts exception (ADR-017), mirroring
// `OrderLineView` / `CartLineView`.
//
// `orderLineId` points back at the placed order's line; `quantity` is the number of
// units of that line included in this shipment (a partial shipment carries fewer
// than the line's ordered quantity, the remainder shipping in a later fulfillment).
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
