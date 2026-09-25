import { DomainException } from '@retail-inventory-system/common';

export enum CartErrorCodeEnum {
  CART_CURRENCY_INVALID = 'CART_CURRENCY_INVALID',
  CART_VERSION_INVALID = 'CART_VERSION_INVALID',
  CART_NOT_ACTIVE = 'CART_NOT_ACTIVE',
  CART_INVALID_STATE_TRANSITION = 'CART_INVALID_STATE_TRANSITION',
  CART_LINE_NOT_FOUND = 'CART_LINE_NOT_FOUND',
  CART_LINE_QUANTITY_INVALID = 'CART_LINE_QUANTITY_INVALID',
  CART_LINE_VARIANT_INVALID = 'CART_LINE_VARIANT_INVALID',
  CART_LINE_PRICE_INVALID = 'CART_LINE_PRICE_INVALID',
  CART_LINE_CURRENCY_REQUIRED = 'CART_LINE_CURRENCY_REQUIRED',
  CART_NOT_FOUND = 'CART_NOT_FOUND',
  CART_ACCESS_FORBIDDEN = 'CART_ACCESS_FORBIDDEN',
  CART_VARIANT_NOT_PRICED = 'CART_VARIANT_NOT_PRICED',
  CART_VERSION_MISMATCH = 'VERSION_MISMATCH',
}

export class CartDomainException extends DomainException {
  public readonly code: CartErrorCodeEnum;
  public readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: CartErrorCodeEnum,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
