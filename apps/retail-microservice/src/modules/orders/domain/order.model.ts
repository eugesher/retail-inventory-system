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
