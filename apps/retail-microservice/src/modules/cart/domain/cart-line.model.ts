import { Entity } from '@retail-inventory-system/ddd';

import { CartDomainException, CartErrorCodeEnum } from './cart.exception';

export interface ICartLineProps {
  id: number | null;
  variantId: number;
  quantity: number;
  unitPriceSnapshotMinor: number;
  currencySnapshot: string;
}

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

  public get lineSubtotalMinor(): number {
    return this.unitPriceSnapshotMinor * this._quantity;
  }

  public changeQuantity(quantity: number): void {
    this._quantity = CartLine.requirePositiveQuantity(quantity);
  }

  public increaseQuantity(delta: number): void {
    this.changeQuantity(this._quantity + CartLine.requirePositiveQuantity(delta));
  }
}
