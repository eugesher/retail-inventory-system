import { ApiResponseProperty } from '@nestjs/swagger';

import {
  ReturnDispositionEnum,
  ReturnLineConditionEnum,
  ReturnReasonCategoryEnum,
  ReturnStatusEnum,
} from '../enums';

// One return line: which `OrderLine` quantity is coming back, and — once the warehouse has
// inspected it — what became of it.
//
// `condition`, `disposition` and `lineRefundAmountMinor` are all `null` until that inspection
// happens. A `null` there means "not yet inspected", never "inspected and found to be nothing".
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
