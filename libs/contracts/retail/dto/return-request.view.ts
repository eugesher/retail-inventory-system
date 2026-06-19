import { ApiResponseProperty } from '@nestjs/swagger';

import {
  ReturnDispositionEnum,
  ReturnLineConditionEnum,
  ReturnReasonCategoryEnum,
  ReturnStatusEnum,
} from '../enums';

// RPC/HTTP response shape for one return line — which `OrderLine` quantity is coming
// back, with the per-line inspection outcome once it has been recorded. A **class**
// carrying `@ApiResponseProperty` (not a plain interface) so the gateway can declare
// it as a Swagger response type — `@nestjs/swagger` is the documented lib-contracts
// exception (ADR-017), mirroring `FulfillmentLineView` / `OrderLineView`.
//
// `orderLineId` points back at the placed order's line; `quantity` is the number of
// units of that line being returned. `condition` / `disposition` /
// `lineRefundAmountMinor` are all `null` until the line is inspected (the warehouse
// `inventory:receive-return` step records them).
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

// RPC/HTTP response shape for a whole return request — the RMA record that drives a
// delivered/shipped order's return through its six-state lifecycle. A **class**
// carrying `@ApiResponseProperty` (the documented lib-contracts Swagger exception,
// ADR-017), mirroring `OrderView` / `FulfillmentView`.
//
// `rmaNumber` is the human-facing `RMA-<year>-<pad8(id)>` finalized from the generated
// id post-persist (`null` until then, the `order_number` idiom). `orderId` /
// `customerId` are opaque ids (the order the goods came from, the buyer). `status` is
// the RMA's lifecycle axis (`ReturnStatusEnum`); `reasonCategory` the coarse return
// reason; `notes` an optional free-text note. `requestedAt` is stamped at Open;
// `authorizedAt` once authorized; `closedAt` once rejected or closed (both terminal).
// `version` is the per-RMA optimistic-concurrency token (the cross-cutting concurrency
// rule). `lines` are the per-`OrderLine` quantities being returned.
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
