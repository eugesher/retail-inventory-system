import { OrderLineStatusEnum } from '@retail-inventory-system/contracts';
import { Entity } from '@retail-inventory-system/ddd';

import { OrderDomainException, OrderErrorCodeEnum } from './order.exception';

export interface IOrderLineProps {
  id: number | null;
  variantId: number;
  sku: string;
  nameSnapshot: string;
  quantity: number;
  // Units of this line cancelled by Cancel Line (ADR-031). Defaults to 0; on the load
  // path it carries the persisted `order_line.cancelled_quantity`.
  cancelledQuantity?: number;
  unitPriceMinor: number;
  taxAmountMinor?: number;
  discountAmountMinor?: number;
  // Optional on input: omit it and the line derives it from the formula; pass it
  // (the load path) and it is asserted to equal the formula so a corrupted stored
  // total is rejected on read.
  lineTotalMinor?: number;
  status?: OrderLineStatusEnum;
}

// A line of a placed order and a *child entity* of the immutable `Order` aggregate
// root — never persisted or mutated on its own; the `Order` root holds and
// validates it (ADR-028). The `number | null` id mirrors the catalog
// `ProductVariant` / `CartLine`: null before persistence assigns the BIGINT,
// concrete after `reconstitute`.
//
// `variantId` is an OPAQUE cross-service link to the catalog `product_variant` —
// the retail domain MUST NOT import the catalog `ProductVariant`; the only coupling
// is the FK in persistence (ADR-004 / ADR-017 / ADR-025).
//
// Every **money/identity** field is a snapshot taken at place-time and is immutable
// for the life of the line — `sku`, `nameSnapshot`, and `unitPriceMinor` are the
// identity/price as they stood at purchase, the buyer's contract, decoupled from any
// later catalog or pricing change (ADR-028 §1). The only mutable field is `status`:
// the line's fulfillment progress advances as shipments go out (the Ship operation
// flips it `allocated → partially-shipped → shipped`, ADR-031). So the line is **not**
// `Object.freeze`d — that would freeze `status` too — but every snapshot field stays
// `readonly` (compile-time immutable) and carries no setter; only `markFulfillment`
// can move `status`, and only forward.
export class OrderLine extends Entity<number | null> {
  public readonly variantId: number;
  public readonly sku: string;
  public readonly nameSnapshot: string;
  public readonly quantity: number;
  public readonly unitPriceMinor: number;
  public readonly taxAmountMinor: number;
  public readonly discountAmountMinor: number;
  public readonly lineTotalMinor: number;
  private _status: OrderLineStatusEnum;
  private _cancelledQuantity: number;

  constructor(props: IOrderLineProps) {
    if (!Number.isInteger(props.variantId) || props.variantId <= 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_LINE_VARIANT_INVALID,
        `OrderLine.variantId must be a positive integer, got ${props.variantId}`,
      );
    }
    if (!Number.isInteger(props.quantity) || props.quantity <= 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_LINE_QUANTITY_INVALID,
        `OrderLine.quantity must be a positive integer, got ${props.quantity}`,
      );
    }
    // `0 ≤ cancelledQuantity ≤ quantity` — the same bound the `cancelled_quantity`
    // CHECK enforces in storage, so a corrupted stored count is rejected on read.
    const cancelledQuantity = props.cancelledQuantity ?? 0;
    if (
      !Number.isInteger(cancelledQuantity) ||
      cancelledQuantity < 0 ||
      cancelledQuantity > props.quantity
    ) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_LINE_QUANTITY_INVALID,
        `OrderLine.cancelledQuantity must be an integer within [0, ${props.quantity}], got ${cancelledQuantity}`,
      );
    }
    if (typeof props.sku !== 'string' || props.sku.trim().length === 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_LINE_SKU_REQUIRED,
        'OrderLine.sku must be a non-empty string',
      );
    }
    if (typeof props.nameSnapshot !== 'string' || props.nameSnapshot.trim().length === 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_LINE_NAME_REQUIRED,
        'OrderLine.nameSnapshot must be a non-empty string',
      );
    }

    const taxAmountMinor = props.taxAmountMinor ?? 0;
    const discountAmountMinor = props.discountAmountMinor ?? 0;
    OrderLine.requireNonNegativeMoney(props.unitPriceMinor, 'unitPriceMinor');
    OrderLine.requireNonNegativeMoney(taxAmountMinor, 'taxAmountMinor');
    OrderLine.requireNonNegativeMoney(discountAmountMinor, 'discountAmountMinor');

    // `lineTotalMinor = unitPriceMinor × quantity + taxAmountMinor −
    // discountAmountMinor`. In this capability tax/discount are 0, so the line
    // total is just `unitPriceMinor × quantity`. Derive it when omitted; assert it
    // when supplied (the load path) so a corrupted stored value never reconstitutes
    // silently.
    const expected = props.unitPriceMinor * props.quantity + taxAmountMinor - discountAmountMinor;
    if (props.lineTotalMinor !== undefined && props.lineTotalMinor !== expected) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_LINE_TOTAL_MISMATCH,
        `OrderLine.lineTotalMinor (${props.lineTotalMinor}) must equal unitPriceMinor × quantity + tax − discount (${expected})`,
      );
    }
    OrderLine.requireNonNegativeMoney(expected, 'lineTotalMinor');

    super(props.id);
    this.variantId = props.variantId;
    this.sku = props.sku;
    this.nameSnapshot = props.nameSnapshot;
    this.quantity = props.quantity;
    this.unitPriceMinor = props.unitPriceMinor;
    this.taxAmountMinor = taxAmountMinor;
    this.discountAmountMinor = discountAmountMinor;
    this.lineTotalMinor = expected;
    this._cancelledQuantity = cancelledQuantity;
    // A line starts `ALLOCATED` at place-time — a forward-compatible sentinel; real
    // allocation lands with the inventory-reservation capability.
    this._status = props.status ?? OrderLineStatusEnum.ALLOCATED;
  }

  public get status(): OrderLineStatusEnum {
    return this._status;
  }

  public get cancelledQuantity(): number {
    return this._cancelledQuantity;
  }

  // The units of this line that are still live: what remains shippable, and (once
  // delivered) returnable. Every quantity rule downstream measures against THIS, not the
  // place-time `quantity` — cancelling units removes them from the order's obligations
  // without rewriting the buyer's money snapshot.
  public get activeQuantity(): number {
    return this.quantity - this._cancelledQuantity;
  }

  // **The last thing standing between a caller's arithmetic and an over-release of stock.**
  //
  // The line cannot see the `fulfillment` rows, so it cannot know how many units already shipped —
  // the caller establishes that. What the line *does* own is its own bound: cancelled units may
  // never exceed `activeQuantity`, so a repeat cancel of the same units is refused **even if the
  // caller's remainder maths were wrong**. That bound is load-bearing, because the quantity released
  // back to inventory is derived from what was cancelled here: **bound the cancellation and you have
  // bounded the release.**
  //
  // Carries **no money mutation.** `lineTotalMinor` stays the place-time snapshot — cancelling units
  // does not credit them, and a refund is a separate, explicit act. Cancelling the whole line moves
  // it to `cancelled`; a partial cancel leaves the fulfillment-progress status alone, because the
  // remaining units still ship.
  public cancelQuantity(units: number): void {
    if (!Number.isInteger(units) || units <= 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_LINE_QUANTITY_INVALID,
        `OrderLine.cancelQuantity: units must be a positive integer, got ${units}`,
      );
    }
    if (units > this.activeQuantity) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.FULFILLMENT_QUANTITY_EXCEEDS_REMAINING,
        `OrderLine ${this.id}: cannot cancel ${units} — only ${this.activeQuantity} of the ${this.quantity} ordered remain uncancelled`,
      );
    }
    this._cancelledQuantity += units;
    // A fully-cancelled line is terminal. It can only reach here with nothing fulfilled
    // (the caller cancels unshipped units only), so no fulfillment-progress status is
    // being overwritten.
    if (this.activeQuantity === 0) {
      this._status = OrderLineStatusEnum.CANCELLED;
    }
  }

  // Advances the line's fulfillment progress along `allocated → partially-shipped →
  // shipped` as the Ship operation moves units out (ADR-031). The use case computes
  // the target from the line's shipped-vs-ordered quantity across the order's
  // fulfillments, so this mutator only guards the axis. A move to the same status is
  // an idempotent no-op (the Ship recompute touches every order line, including ones a
  // prior shipment already fully shipped). A **strictly backward** move, or a move to a
  // status outside the fulfillment-progress subset, is an internal-invariant breach the use
  // case never produces — a plain `Error` (500), the `OrderLine`-other-guards style. Carries
  // no money mutation, so the place-time snapshot stays intact.
  //
  // `cancelled` and `returned` are outside that subset, for different reasons: `cancelled` is
  // reached, but by `cancelQuantity` above (a different axis), so routing it through here would
  // be a bug; `returned` has no producer anywhere.
  public markFulfillment(next: OrderLineStatusEnum): void {
    const target = OrderLine.fulfillmentRank(next);
    const current = OrderLine.fulfillmentRank(this._status);
    if (target === null || current === null) {
      throw new Error(
        `OrderLine.markFulfillment: ${next} is not a fulfillment-progress status (line ${this.id})`,
      );
    }
    if (target < current) {
      throw new Error(
        `OrderLine.markFulfillment: cannot move line ${this.id} backward from ${this._status} to ${next}`,
      );
    }
    this._status = next;
  }

  // The forward ordinal of the fulfillment-progress subset; `null` for `cancelled`/`returned`,
  // so a stray call with one of them is rejected rather than silently ranked.
  private static fulfillmentRank(status: OrderLineStatusEnum): number | null {
    switch (status) {
      case OrderLineStatusEnum.ALLOCATED:
        return 0;
      case OrderLineStatusEnum.PARTIALLY_SHIPPED:
        return 1;
      case OrderLineStatusEnum.SHIPPED:
        return 2;
      default:
        return null;
    }
  }

  private static requireNonNegativeMoney(value: number, field: string): void {
    if (!Number.isInteger(value) || value < 0) {
      throw new OrderDomainException(
        OrderErrorCodeEnum.ORDER_LINE_MONEY_INVALID,
        `OrderLine.${field} must be a non-negative integer (minor units), got ${value}`,
      );
    }
  }
}
