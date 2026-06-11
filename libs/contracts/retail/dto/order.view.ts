import { ApiResponseProperty } from '@nestjs/swagger';

import {
  OrderFulfillmentStatusEnum,
  OrderLineStatusEnum,
  OrderPaymentStatusEnum,
  OrderStatusEnum,
} from '../enums';
import { PaymentView } from './payment.view';

// RPC/HTTP response shape for one order line. A **class** carrying
// `@ApiResponseProperty` (not a plain interface) so the gateway can declare it as
// a Swagger response type — `@nestjs/swagger` is the documented lib-contracts
// exception (ADR-017), mirroring `CartLineView` / `PriceView`.
//
// `sku`, `nameSnapshot`, and `unitPriceMinor` are **snapshots** taken at place-time
// — the price/identity as it stood at purchase, decoupled from any later catalog
// change (ADR-028 §1). All money is an integer count of minor units (cents), never
// a float. `lineTotalMinor = unitPriceMinor × quantity + taxAmountMinor −
// discountAmountMinor`; in this capability `taxAmountMinor` and
// `discountAmountMinor` are always `0` (tax/discount are later capabilities), so
// `lineTotalMinor = unitPriceMinor × quantity`.
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

// RPC/HTTP response shape for a whole order. The three status fields are
// **orthogonal** (ADR-028 §2): `status` (the order lifecycle), `paymentStatus`, and
// `fulfillmentStatus` each evolve independently. `customerId` is the gateway
// customer UUID, **nullable** so a deleted customer leaves an order tombstone
// (ADR-024). `currency` is the immutable CHAR(3) the order was placed in.
//
// The five money totals are all integer minor units; in this capability
// `grandTotalMinor = subtotalMinor = Σ lines.lineTotalMinor` because
// `taxTotalMinor`, `discountTotalMinor`, and `shippingTotalMinor` are `0` (tax,
// discount, and shipping are later/excluded capabilities). `billingAddressId` /
// `shippingAddressId` are CHAR(36) pointers to snapshotted `address` rows.
// `version` is the optimistic-concurrency token (shipped now though enforcement is
// a later capability, ADR-028 §6). `payment` is the optional payment row for the
// order — absent (`undefined`) until an order is placed-and-authorized, present
// once a `payment` row exists (authorize-on-place / capture capabilities).
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
