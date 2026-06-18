import {
  OrderFulfillmentStatusEnum,
  OrderPaymentStatusEnum,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';
import { AggregateRoot } from '@retail-inventory-system/ddd';

import { OrderLine } from './order-line.model';
import { OrderDomainException, OrderErrorCodeEnum } from './order.exception';

export interface IOrderProps {
  id: number | null;
  orderNumber: string;
  customerId: string | null;
  currency: string;
  status?: OrderStatusEnum;
  paymentStatus?: OrderPaymentStatusEnum;
  fulfillmentStatus?: OrderFulfillmentStatusEnum;
  lines: OrderLine[];
  subtotalMinor: number;
  taxTotalMinor?: number;
  discountTotalMinor?: number;
  shippingTotalMinor?: number;
  grandTotalMinor: number;
  billingAddressId: string | null;
  shippingAddressId: string | null;
  sourceCartId: string | null;
  placedAt: Date | null;
  version?: number;
  createdAt?: Date | null;
  updatedAt?: Date | null;
}

// Input to the place-time factory. Totals are NOT supplied — `place` derives them
// from the (already-snapshotted) lines, so the header totals can never disagree
// with the line totals at placement.
export interface IPlaceOrderInput {
  orderNumber: string;
  customerId: string | null;
  currency: string;
  lines: OrderLine[];
  billingAddressId: string | null;
  shippingAddressId: string | null;
  sourceCartId: string | null;
  placedAt: Date;
}

// 3-letter ISO-4217-shaped currency code, validated so a malformed code never
// reaches the CHAR(3) column.
const CURRENCY_PATTERN = /^[A-Za-z]{3}$/;

// `Order` is the retail **immutable** aggregate root: the placed record of what was
// bought and at what price, the counterpart to the mutable `Cart`. Placing an order
// is a one-shot conversion — the cart's lines are snapshotted into `OrderLine`s and
// the cart is marked `converted`; no later cart edit can corrupt this snapshot
// (ADR-028 §1).
//
// It carries **three orthogonal status axes** (ADR-028 §2) — `status`,
// `paymentStatus`, `fulfillmentStatus` — that evolve independently; a combination
// like `paymentStatus = captured` + `fulfillmentStatus = unfulfilled` is valid by
// construction. This foundation never transitions the lifecycle/fulfillment axes
// (they start `pending`/`unfulfilled` and stay there); only the payment axis has
// mutators here.
//
// The id is the auto-increment BIGINT assigned by persistence (`null` until then),
// unlike the cart's in-app UUID. `orderNumber` is the human-facing label finalized
// by the repository from the generated id (see `OrderTypeormRepository`).
//
// `version` is the optimistic-concurrency token: it ships and advances on every
// mutation now, even though no concurrency guard consumes it yet — retrofitting an
// OCC column onto a populated table later is a destructive `ALTER TABLE`, so the
// column is cheapest up front (ADR-028 §6).
export class Order extends AggregateRoot<number | null> {
  private readonly _orderNumber: string;
  private readonly _customerId: string | null;
  private readonly _currency: string;
  private _status: OrderStatusEnum;
  private _paymentStatus: OrderPaymentStatusEnum;
  private _fulfillmentStatus: OrderFulfillmentStatusEnum;
  private readonly _lines: OrderLine[];
  private readonly _subtotalMinor: number;
  private readonly _taxTotalMinor: number;
  private readonly _discountTotalMinor: number;
  private readonly _shippingTotalMinor: number;
  private readonly _grandTotalMinor: number;
  private readonly _billingAddressId: string | null;
  private readonly _shippingAddressId: string | null;
  private readonly _sourceCartId: string | null;
  private readonly _placedAt: Date | null;
  private _version: number;
  public readonly createdAt: Date | null;
  public readonly updatedAt: Date | null;

  private constructor(props: IOrderProps) {
    if (typeof props.currency !== 'string' || !CURRENCY_PATTERN.test(props.currency)) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_CURRENCY_INVALID,
        `Order.currency must be a non-empty 3-letter code, got ${String(props.currency)}`,
      );
    }
    if (props.lines.length === 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_NO_LINES,
        'Order must carry at least one line',
      );
    }

    const taxTotalMinor = props.taxTotalMinor ?? 0;
    const discountTotalMinor = props.discountTotalMinor ?? 0;
    const shippingTotalMinor = props.shippingTotalMinor ?? 0;
    Order.requireNonNegativeMoney(props.subtotalMinor, 'subtotalMinor');
    Order.requireNonNegativeMoney(taxTotalMinor, 'taxTotalMinor');
    Order.requireNonNegativeMoney(discountTotalMinor, 'discountTotalMinor');
    Order.requireNonNegativeMoney(shippingTotalMinor, 'shippingTotalMinor');
    Order.requireNonNegativeMoney(props.grandTotalMinor, 'grandTotalMinor');

    // The total invariant: the header subtotal must equal the sum of the line
    // totals, and the grand total must reconcile across all components. In this
    // capability tax/discount/shipping are 0 (no tax/discount/shipping capability
    // yet — the tax category is a classification label only, ADR-026), so
    // `grandTotalMinor = subtotalMinor = Σ line.lineTotalMinor`.
    const lineSum = props.lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
    if (props.subtotalMinor !== lineSum) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_TOTAL_MISMATCH,
        `Order.subtotalMinor (${props.subtotalMinor}) must equal Σ line.lineTotalMinor (${lineSum})`,
      );
    }
    const expectedGrand =
      props.subtotalMinor + taxTotalMinor + shippingTotalMinor - discountTotalMinor;
    if (props.grandTotalMinor !== expectedGrand) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_TOTAL_MISMATCH,
        `Order.grandTotalMinor (${props.grandTotalMinor}) must equal subtotal + tax + shipping − discount (${expectedGrand})`,
      );
    }

    const version = props.version ?? 0;
    if (!Number.isInteger(version) || version < 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_VERSION_INVALID,
        `Order.version must be a non-negative integer, got ${version}`,
      );
    }

    super(props.id);
    this._orderNumber = props.orderNumber;
    this._customerId = props.customerId;
    this._currency = props.currency;
    this._status = props.status ?? OrderStatusEnum.PENDING;
    this._paymentStatus = props.paymentStatus ?? OrderPaymentStatusEnum.NONE;
    this._fulfillmentStatus = props.fulfillmentStatus ?? OrderFulfillmentStatusEnum.UNFULFILLED;
    this._lines = props.lines;
    this._subtotalMinor = props.subtotalMinor;
    this._taxTotalMinor = taxTotalMinor;
    this._discountTotalMinor = discountTotalMinor;
    this._shippingTotalMinor = shippingTotalMinor;
    this._grandTotalMinor = props.grandTotalMinor;
    this._billingAddressId = props.billingAddressId;
    this._shippingAddressId = props.shippingAddressId;
    this._sourceCartId = props.sourceCartId;
    this._placedAt = props.placedAt;
    this._version = version;
    this.createdAt = props.createdAt ?? null;
    this.updatedAt = props.updatedAt ?? null;
  }

  // The place-time factory: validates ≥ 1 line + currency, derives the totals from
  // the (already-snapshotted) lines, and opens the order `PENDING` / `NONE` /
  // `UNFULFILLED` at `version 0`. The lines arrive already snapshotted (the caller
  // builds them from the cart at place-time) — the factory fetches nothing.
  //
  // `id` is null until persistence assigns the BIGINT; `orderNumber` is the
  // provisional label the repository finalizes from the generated id on first save.
  // Records no domain event here — the `retail.order.placed` event is emitted by
  // the place use case after persistence assigns the id (a later capability), never
  // serialized from the domain across services (ADR-011).
  public static place(input: IPlaceOrderInput): Order {
    const subtotalMinor = input.lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
    return new Order({
      id: null,
      orderNumber: input.orderNumber,
      customerId: input.customerId,
      currency: input.currency,
      status: OrderStatusEnum.PENDING,
      paymentStatus: OrderPaymentStatusEnum.NONE,
      fulfillmentStatus: OrderFulfillmentStatusEnum.UNFULFILLED,
      lines: input.lines,
      subtotalMinor,
      // No tax/discount/shipping capability yet — these stay 0, so
      // grandTotal = subtotal.
      taxTotalMinor: 0,
      discountTotalMinor: 0,
      shippingTotalMinor: 0,
      grandTotalMinor: subtotalMinor,
      billingAddressId: input.billingAddressId,
      shippingAddressId: input.shippingAddressId,
      sourceCartId: input.sourceCartId,
      placedAt: input.placedAt,
      version: 0,
    });
  }

  // Rebuilds a persisted order from storage (any status / version). Records no
  // events. The constructor re-asserts the total invariant, so a corrupted stored
  // graph is rejected on read.
  public static reconstitute(props: IOrderProps): Order {
    return new Order(props);
  }

  public get orderNumber(): string {
    return this._orderNumber;
  }

  public get customerId(): string | null {
    return this._customerId;
  }

  public get currency(): string {
    return this._currency;
  }

  public get status(): OrderStatusEnum {
    return this._status;
  }

  public get paymentStatus(): OrderPaymentStatusEnum {
    return this._paymentStatus;
  }

  public get fulfillmentStatus(): OrderFulfillmentStatusEnum {
    return this._fulfillmentStatus;
  }

  public get lines(): readonly OrderLine[] {
    return this._lines;
  }

  public get subtotalMinor(): number {
    return this._subtotalMinor;
  }

  public get taxTotalMinor(): number {
    return this._taxTotalMinor;
  }

  public get discountTotalMinor(): number {
    return this._discountTotalMinor;
  }

  public get shippingTotalMinor(): number {
    return this._shippingTotalMinor;
  }

  public get grandTotalMinor(): number {
    return this._grandTotalMinor;
  }

  public get billingAddressId(): string | null {
    return this._billingAddressId;
  }

  public get shippingAddressId(): string | null {
    return this._shippingAddressId;
  }

  public get sourceCartId(): string | null {
    return this._sourceCartId;
  }

  public get placedAt(): Date | null {
    return this._placedAt;
  }

  public get version(): number {
    return this._version;
  }

  // Payment axis: `none → authorized`. Driven by the authorize-on-place capability;
  // rejects any non-`none` start. Bumps the OCC token. Touches only the payment
  // axis — the order lifecycle and fulfillment axes are untouched (orthogonality,
  // ADR-028 §2).
  public markPaymentAuthorized(): void {
    if (this._paymentStatus !== OrderPaymentStatusEnum.NONE) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_INVALID_PAYMENT_TRANSITION,
        `Order.markPaymentAuthorized: can only authorize a payment in 'none' (current: ${this._paymentStatus})`,
      );
    }
    this._paymentStatus = OrderPaymentStatusEnum.AUTHORIZED;
    this.bumpVersion();
  }

  // Payment axis: `authorized → captured`. Driven by the explicit capture
  // capability; rejects any non-`authorized` start. Bumps the OCC token. (Refund /
  // fail land with later capabilities — deliberately absent here.)
  public markPaymentCaptured(): void {
    if (this._paymentStatus !== OrderPaymentStatusEnum.AUTHORIZED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_INVALID_PAYMENT_TRANSITION,
        `Order.markPaymentCaptured: can only capture an authorized payment (current: ${this._paymentStatus})`,
      );
    }
    this._paymentStatus = OrderPaymentStatusEnum.CAPTURED;
    this.bumpVersion();
  }

  // Fulfillment axis: advances the order's **roll-up** fulfillment status along the
  // forward chain `unfulfilled → partially-shipped → shipped → delivered`. Driven by
  // the Ship operation (sets `partially-shipped` or `shipped`) and the Deliver
  // operation (sets `delivered`); the use case computes the target from the order's
  // fulfillments' shipped line quantities, so this mutator only guards the axis, not
  // the arithmetic. A **strictly backward** move (e.g. `shipped → partially-shipped`)
  // is rejected `ORDER_INVALID_FULFILLMENT_TRANSITION` (409); a forward-or-equal move
  // is allowed (a single full ship goes `unfulfilled → shipped` directly, and a
  // further partial ship that still does not complete the order stays
  // `partially-shipped`). Bumps the OCC token. Touches **only** the fulfillment axis —
  // the lifecycle and payment axes are untouched (orthogonality, ADR-028 §2).
  public advanceFulfillment(next: OrderFulfillmentStatusEnum): void {
    if (Order.fulfillmentRank(next) < Order.fulfillmentRank(this._fulfillmentStatus)) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_INVALID_FULFILLMENT_TRANSITION,
        `Order.advanceFulfillment: cannot move the fulfillment axis backward from ${this._fulfillmentStatus} to ${next}`,
      );
    }
    this._fulfillmentStatus = next;
    this.bumpVersion();
  }

  // Lifecycle axis: `pending`/`confirmed → CANCELLED` (terminal). Driven by Cancel
  // Order. Rejects an already-`cancelled` order and — crucially — a `shipped`/
  // `delivered` one with `ORDER_NOT_CANCELLABLE` (409): an order whose lifecycle has
  // advanced past placement can no longer be unwound here. (The Cancel Order use case
  // ALSO guards on the presence of a `shipped`/`delivered` *fulfillment* before calling
  // this — the lifecycle axis stays `pending` after a ship, so the fulfillment check is
  // the real shipped-stock guard, and this mutator is the lifecycle backstop.) Bumps the
  // OCC token. Touches **only** the lifecycle axis — the payment axis keeps its value
  // (the `payment` row carries `voided`; the order's payment *axis* has no `voided`
  // member, the deliberate orthogonality of ADR-028 §2), and the fulfillment axis is
  // untouched.
  public cancel(): void {
    if (this._status !== OrderStatusEnum.PENDING && this._status !== OrderStatusEnum.CONFIRMED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_NOT_CANCELLABLE,
        `Order.cancel: can only cancel a pending or confirmed order (current: ${this._status})`,
      );
    }
    this._status = OrderStatusEnum.CANCELLED;
    this.bumpVersion();
  }

  // Delivery is the happy-path terminal: it advances **both** the lifecycle axis
  // (`→ DELIVERED`) and the fulfillment axis (`→ DELIVERED`) in one mutation. Driven by
  // Mark Delivered once every non-`cancelled` fulfillment of the order is delivered.
  // Requires the order to be `shipped`-reachable — the fulfillment axis must be
  // `partially-shipped` or `shipped` (something physically went out) and the lifecycle
  // must not be `cancelled` — else `ORDER_INVALID_FULFILLMENT_TRANSITION` (409). Bumps
  // the OCC token once.
  public markDelivered(): void {
    if (this._status === OrderStatusEnum.CANCELLED) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_INVALID_FULFILLMENT_TRANSITION,
        'Order.markDelivered: a cancelled order cannot be delivered',
      );
    }
    if (
      this._fulfillmentStatus !== OrderFulfillmentStatusEnum.PARTIALLY_SHIPPED &&
      this._fulfillmentStatus !== OrderFulfillmentStatusEnum.SHIPPED
    ) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_INVALID_FULFILLMENT_TRANSITION,
        `Order.markDelivered: can only deliver a shipped order (fulfillment axis: ${this._fulfillmentStatus})`,
      );
    }
    this._status = OrderStatusEnum.DELIVERED;
    this._fulfillmentStatus = OrderFulfillmentStatusEnum.DELIVERED;
    this.bumpVersion();
  }

  // The forward ordinal of each fulfillment-axis value. A move is legal iff it does
  // not decrease this rank — encoding the `unfulfilled → partially-shipped → shipped
  // → delivered` chain without forbidding the legitimate "skip" of a full single
  // ship (`unfulfilled → shipped`).
  private static fulfillmentRank(status: OrderFulfillmentStatusEnum): number {
    switch (status) {
      case OrderFulfillmentStatusEnum.UNFULFILLED:
        return 0;
      case OrderFulfillmentStatusEnum.PARTIALLY_SHIPPED:
        return 1;
      case OrderFulfillmentStatusEnum.SHIPPED:
        return 2;
      case OrderFulfillmentStatusEnum.DELIVERED:
        return 3;
    }
  }

  private static requireNonNegativeMoney(value: number, field: string): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_MONEY_INVALID,
        `Order.${field} must be a non-negative integer (minor units), got ${value}`,
      );
    }
  }

  // Every mutation advances the OCC token so "version bumps on each mutation" is
  // observable. Persistence delegates the stored value to TypeORM's
  // `@VersionColumn`; this in-memory bump keeps the domain self-describing.
  private bumpVersion(): void {
    this._version += 1;
  }
}
