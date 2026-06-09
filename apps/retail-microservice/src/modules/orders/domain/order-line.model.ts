import { OrderLineStatusEnum } from '@retail-inventory-system/contracts';
import { Entity } from '@retail-inventory-system/ddd';

import { OrderDomainException, OrderErrorCodeEnum } from './order.exception';

export interface IOrderLineProps {
  id: number | null;
  variantId: number;
  sku: string;
  nameSnapshot: string;
  quantity: number;
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
// Every field is a **snapshot taken at place-time** and is immutable for the life
// of the line — `sku`, `nameSnapshot`, and `unitPriceMinor` are the identity/price
// as they stood at purchase, the buyer's contract, decoupled from any later catalog
// or pricing change (ADR-028 §1). The line carries no setters at all: an order is
// an immutable record, so a line never changes once placed.
export class OrderLine extends Entity<number | null> {
  public readonly variantId: number;
  public readonly sku: string;
  public readonly nameSnapshot: string;
  public readonly quantity: number;
  public readonly unitPriceMinor: number;
  public readonly taxAmountMinor: number;
  public readonly discountAmountMinor: number;
  public readonly lineTotalMinor: number;
  public readonly status: OrderLineStatusEnum;

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
    // A line starts `ALLOCATED` at place-time — a forward-compatible sentinel; real
    // allocation lands with the inventory-reservation capability.
    this.status = props.status ?? OrderLineStatusEnum.ALLOCATED;

    // The line is a fully immutable place-time snapshot — an order is an immutable
    // record, so a line never changes once placed. `readonly` is a compile-time-only
    // guard, so freezing makes the immutability real at runtime: any write throws in
    // strict mode. (`OrderLine extends Entity`, not `AggregateRoot`, so there is no
    // `pullDomainEvents()` mutation to break — unlike `Order` / `Address`.)
    Object.freeze(this);
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
