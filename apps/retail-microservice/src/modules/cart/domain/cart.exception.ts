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
  // A cart operation named a cartId that does not exist — 404. Raised by the
  // Get/Add/Change/Remove/Claim use cases when the repository returns null.
  CART_NOT_FOUND = 'CART_NOT_FOUND',
  // The caller is not the cart's owner (`cart.customerId !== caller`) — 403. The
  // owner-check is enforced both at the gateway (it holds `@CurrentUser()`) and
  // here as defense-in-depth so the retail service never blindly trusts the edge
  // (ADR-028 §7). Claim raises it when the `fromCustomerId` ownership proof fails.
  CART_ACCESS_FORBIDDEN = 'CART_ACCESS_FORBIDDEN',
  // Add-to-Cart could not resolve an applicable price for the variant in the
  // cart's currency (unknown or unpriced variant) — a 409: the variant cannot be
  // added in its current pricing state. A cart line must carry a real price
  // snapshot, so the operation is rejected rather than persisting a zero price.
  CART_VARIANT_NOT_PRICED = 'CART_VARIANT_NOT_PRICED',
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
