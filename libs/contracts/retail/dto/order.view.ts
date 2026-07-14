import { ApiResponseProperty } from '@nestjs/swagger';

import {
  OrderFulfillmentStatusEnum,
  OrderLineStatusEnum,
  OrderPaymentStatusEnum,
  OrderStatusEnum,
} from '../enums';
import { PaymentView } from './payment.view';

// `sku`, `nameSnapshot` and `unitPriceMinor` are **snapshots** taken at place-time: the price and
// identity as they stood at purchase, decoupled from any later catalog change (ADR-028 §1). All
// money is an integer count of minor units, never a float.
//
// `lineTotalMinor = unitPriceMinor × quantity + taxAmountMinor − discountAmountMinor`. The
// system computes no tax and no discount, so both of those are always `0` and the total reduces
// to `unitPriceMinor × quantity` — do not read a non-zero one as reachable.
export class OrderLineView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public variantId: number;

  @ApiResponseProperty()
  public sku: string;

  @ApiResponseProperty()
  public nameSnapshot: string;

  @ApiResponseProperty()
  public quantity: number;

  // Units of this line cancelled by Cancel Line. `quantity − cancelledQuantity` is what
  // remains shippable and returnable; the money fields keep the place-time snapshot.
  @ApiResponseProperty()
  public cancelledQuantity: number;

  @ApiResponseProperty()
  public unitPriceMinor: number;

  @ApiResponseProperty()
  public taxAmountMinor: number;

  @ApiResponseProperty()
  public discountAmountMinor: number;

  @ApiResponseProperty()
  public lineTotalMinor: number;

  @ApiResponseProperty()
  public status: OrderLineStatusEnum;
}

// The three status fields are **orthogonal** (ADR-028 §2): `status`, `paymentStatus` and
// `fulfillmentStatus` each evolve independently — none of them can be derived from another.
//
// `customerId` is **nullable**: erasing a customer leaves the order behind as a tombstone
// (ADR-024/037). `version` is the OCC token, and enforcement is live — a stale write loses the
// compare-and-swap and surfaces as a `409` (ADR-036/045).
//
// `grandTotalMinor = subtotalMinor = Σ lines.lineTotalMinor`, because `taxTotalMinor`,
// `discountTotalMinor` and `shippingTotalMinor` are always `0`: the system computes none of the
// three.
export class OrderView {
  @ApiResponseProperty()
  public id: number;

  @ApiResponseProperty()
  public orderNumber: string;

  @ApiResponseProperty()
  public customerId: string | null;

  @ApiResponseProperty()
  public currency: string;

  @ApiResponseProperty()
  public status: OrderStatusEnum;

  @ApiResponseProperty()
  public paymentStatus: OrderPaymentStatusEnum;

  @ApiResponseProperty()
  public fulfillmentStatus: OrderFulfillmentStatusEnum;

  @ApiResponseProperty()
  public subtotalMinor: number;

  @ApiResponseProperty()
  public taxTotalMinor: number;

  @ApiResponseProperty()
  public discountTotalMinor: number;

  @ApiResponseProperty()
  public shippingTotalMinor: number;

  @ApiResponseProperty()
  public grandTotalMinor: number;

  @ApiResponseProperty()
  public billingAddressId: string | null;

  @ApiResponseProperty()
  public shippingAddressId: string | null;

  @ApiResponseProperty()
  public placedAt: string | null;

  @ApiResponseProperty()
  public version: number;

  @ApiResponseProperty({ type: [OrderLineView] })
  public lines: OrderLineView[];

  @ApiResponseProperty({ type: PaymentView })
  public payment?: PaymentView;
}
