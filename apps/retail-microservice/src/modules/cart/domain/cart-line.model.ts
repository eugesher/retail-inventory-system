import { Entity } from '@retail-inventory-system/ddd';

import { CartDomainException, CartErrorCodeEnum } from './cart.exception';

export interface ICartLineProps {
  id: number | null;
  variantId: number;
  quantity: number;
  unitPriceSnapshotMinor: number;
  currencySnapshot: string;
}

// A line of a shopping cart and a *child entity* of the `Cart` aggregate root —
// never persisted or mutated on its own; the `Cart` root adds, mutates, and
// validates it (ADR-028). The `number | null` id mirrors the catalog
// `ProductVariant`: null before persistence assigns the BIGINT, concrete after
// `reconstitute`.
//
// `variantId` is an OPAQUE cross-service link to the catalog `product_variant`
// — the retail domain MUST NOT import the catalog `ProductVariant`; the only
// coupling is the FK in persistence (ADR-004 / ADR-017 / ADR-025).
//
// `unitPriceSnapshotMinor` / `currencySnapshot` are the price as it stood when
// the line was added — captured at add-time and held stable while sibling lines
// mutate (ADR-028 §1). They are immutable on the line (no setters); only
// `quantity` changes after creation.
export class CartLine extends Entity<number | null> {
  private _quantity: number;
  public readonly variantId: number;
  public readonly unitPriceSnapshotMinor: number;
  public readonly currencySnapshot: string;

  constructor(props: ICartLineProps) {
    if (!Number.isInteger(props.variantId) || props.variantId <= 0) {
      throw new CartDomainException(
        CartErrorCodeEnum.CART_LINE_VARIANT_INVALID,
        `CartLine.variantId must be a positive integer, got ${props.variantId}`,
      );
    }
    if (!Number.isInteger(props.unitPriceSnapshotMinor) || props.unitPriceSnapshotMinor < 0) {
      throw new CartDomainException(
        CartErrorCodeEnum.CART_LINE_PRICE_INVALID,
        `CartLine.unitPriceSnapshotMinor must be a non-negative integer, got ${props.unitPriceSnapshotMinor}`,
      );
    }
    if (typeof props.currencySnapshot !== 'string' || props.currencySnapshot.trim().length === 0) {
      throw new CartDomainException(
        CartErrorCodeEnum.CART_LINE_CURRENCY_REQUIRED,
        'CartLine.currencySnapshot must be a non-empty string',
      );
    }

    super(props.id);
    this._quantity = CartLine.requirePositiveQuantity(props.quantity);
    this.variantId = props.variantId;
    this.unitPriceSnapshotMinor = props.unitPriceSnapshotMinor;
    this.currencySnapshot = props.currencySnapshot;
  }

  private static requirePositiveQuantity(quantity: number): number {
    if (!Number.isInteger(quantity) || quantity <= 0) {
      throw new CartDomainException(
        CartErrorCodeEnum.CART_LINE_QUANTITY_INVALID,
        `CartLine.quantity must be a positive integer, got ${quantity}`,
      );
    }
    return quantity;
  }

  public get quantity(): number {
    return this._quantity;
  }

  // Σ-able convenience: the line's contribution to the cart subtotal, in minor
  // units. Pure — derived from the immutable snapshot price and the live
  // quantity.
  public get lineSubtotalMinor(): number {
    return this.unitPriceSnapshotMinor * this._quantity;
  }

  // Replaces the line's quantity with a new positive integer. Driven by the
  // `Cart` root (`changeLineQuantity` and the increment-existing branch of
  // `addLine`); a `0`/negative value is rejected — removal is the explicit op.
  // The snapshot price fields are untouched, so a quantity change never
  // re-prices the line.
  public changeQuantity(quantity: number): void {
    this._quantity = CartLine.requirePositiveQuantity(quantity);
  }

  // Adds to the line's quantity (the increment-existing path). `delta` is the
  // positive quantity from a repeat add of the same variant.
  public increaseQuantity(delta: number): void {
    this.changeQuantity(this._quantity + CartLine.requirePositiveQuantity(delta));
  }
}
