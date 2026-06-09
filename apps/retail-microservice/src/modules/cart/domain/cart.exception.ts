import { DomainException } from '@retail-inventory-system/common';

// Stable, greppable codes for every cart-domain invariant violation. The code is
// the part a presentation-layer exception filter maps onto an HTTP status + wire
// error shape (`{ statusCode, message, code }`); the domain itself stays
// transport-free. The cart context owns its own throwable — the same one-class-
// per-module convention catalog (`CatalogDomainException`) and pricing
// (`PricingDomainException`) follow; the sibling orders module introduces its own
// when it lands. The HTTP filter that maps these arrives with the cart
// operations (the use-case/gateway capability), not this foundation.
export enum CartErrorCodeEnum {
  // A well-formed 3-letter currency is required at create and is immutable
  // thereafter (no setter) — mapped to 400.
  CART_CURRENCY_INVALID = 'CART_CURRENCY_INVALID',
  // The optimistic-concurrency token must be a non-negative integer — 400.
  CART_VERSION_INVALID = 'CART_VERSION_INVALID',
  // A mutation (add/change/remove line, convert, abandon) was attempted on a
  // cart that is no longer `active` — a well-formed request the resource state
  // forbids, mapped to 409.
  CART_NOT_ACTIVE = 'CART_NOT_ACTIVE',
  // `markConverted` / `markAbandoned` from a non-`active` status — 409.
  CART_INVALID_STATE_TRANSITION = 'CART_INVALID_STATE_TRANSITION',
  // `changeLineQuantity` / `removeLine` named a line id the cart does not hold —
  // 404.
  CART_LINE_NOT_FOUND = 'CART_LINE_NOT_FOUND',
  // A line quantity must be a positive integer (`0` is rejected — removal is the
  // explicit op) — 400.
  CART_LINE_QUANTITY_INVALID = 'CART_LINE_QUANTITY_INVALID',
  // A line's opaque `variantId` must be a positive integer — 400.
  CART_LINE_VARIANT_INVALID = 'CART_LINE_VARIANT_INVALID',
  // A line's `unitPriceSnapshotMinor` must be a non-negative integer (minor
  // units) — 400.
  CART_LINE_PRICE_INVALID = 'CART_LINE_PRICE_INVALID',
  // A line's `currencySnapshot` must be a non-empty string — 400.
  CART_LINE_CURRENCY_REQUIRED = 'CART_LINE_CURRENCY_REQUIRED',
}

// One concrete throwable for the cart bounded context, carrying a typed `code`
// from `CartErrorCodeEnum`. Satisfies the framework-free `DomainException` base's
// abstract `code` contract (ADR-025 pattern). Assert `err.code`, never
// string-match the message.
export class CartDomainException extends DomainException {
  public readonly code: CartErrorCodeEnum;

  constructor(code: CartErrorCodeEnum, message: string) {
    super(message);
    this.code = code;
  }
}
