import { DomainException } from '@retail-inventory-system/common';

// Stable, greppable codes for every orders-context invariant violation — covering
// the `Order` root, its `OrderLine` children, and the polymorphic `Address`
// aggregate (all three live in this one bounded-context module, so they share one
// throwable, the same one-class-per-module convention `CartDomainException` /
// `CatalogDomainException` / `PricingDomainException` follow). The code is the part
// a presentation-layer exception filter maps onto an HTTP status + wire error
// shape (`{ statusCode, message, code }`); the domain itself stays transport-free.
// The HTTP filter that maps these arrives with the order operations, not this
// foundation.
export enum OrderErrorCodeEnum {
  // The order currency must be a well-formed 3-letter code and is immutable
  // thereafter (no setter) — mapped to 400.
  ORDER_CURRENCY_INVALID = 'ORDER_CURRENCY_INVALID',
  // An order must carry at least one line — 400.
  ORDER_NO_LINES = 'ORDER_NO_LINES',
  // A money total must be a non-negative integer (minor units) — 400.
  ORDER_MONEY_INVALID = 'ORDER_MONEY_INVALID',
  // The total invariant was violated: `grandTotalMinor = subtotalMinor +
  // taxTotalMinor + shippingTotalMinor − discountTotalMinor`, and `subtotalMinor =
  // Σ line.lineTotalMinor` — 400 (an internal consistency breach).
  ORDER_TOTAL_MISMATCH = 'ORDER_TOTAL_MISMATCH',
  // The optimistic-concurrency token must be a non-negative integer — 400.
  ORDER_VERSION_INVALID = 'ORDER_VERSION_INVALID',
  // A payment-status mutator was called from a state that does not allow it
  // (`markPaymentAuthorized` off non-`none`, `markPaymentCaptured` off
  // non-`authorized`) — a well-formed request the resource state forbids, 409.
  ORDER_INVALID_PAYMENT_TRANSITION = 'ORDER_INVALID_PAYMENT_TRANSITION',

  // A line's opaque `variantId` must be a positive integer — 400.
  ORDER_LINE_VARIANT_INVALID = 'ORDER_LINE_VARIANT_INVALID',
  // A line quantity must be a positive integer — 400.
  ORDER_LINE_QUANTITY_INVALID = 'ORDER_LINE_QUANTITY_INVALID',
  // A line's snapshot `sku` must be a non-empty string — 400.
  ORDER_LINE_SKU_REQUIRED = 'ORDER_LINE_SKU_REQUIRED',
  // A line's snapshot `nameSnapshot` must be a non-empty string — 400.
  ORDER_LINE_NAME_REQUIRED = 'ORDER_LINE_NAME_REQUIRED',
  // A line money field must be a non-negative integer (minor units) — 400.
  ORDER_LINE_MONEY_INVALID = 'ORDER_LINE_MONEY_INVALID',
  // `lineTotalMinor` did not equal `unitPriceMinor × quantity + taxAmountMinor −
  // discountAmountMinor` — 400.
  ORDER_LINE_TOTAL_MISMATCH = 'ORDER_LINE_TOTAL_MISMATCH',

  // An address `ownerType` must be one of the `AddressOwnerTypeEnum` values — 400.
  ADDRESS_OWNER_TYPE_INVALID = 'ADDRESS_OWNER_TYPE_INVALID',
  // An address `ownerId` must be a non-empty string — 400.
  ADDRESS_OWNER_ID_REQUIRED = 'ADDRESS_OWNER_ID_REQUIRED',
  // `recipientName` must be a non-empty string — 400.
  ADDRESS_RECIPIENT_REQUIRED = 'ADDRESS_RECIPIENT_REQUIRED',
  // `line1` must be a non-empty string — 400.
  ADDRESS_LINE1_REQUIRED = 'ADDRESS_LINE1_REQUIRED',
  // `city` must be a non-empty string — 400.
  ADDRESS_CITY_REQUIRED = 'ADDRESS_CITY_REQUIRED',
  // `region` must be a non-empty string — 400.
  ADDRESS_REGION_REQUIRED = 'ADDRESS_REGION_REQUIRED',
  // `postalCode` must be a non-empty string — 400.
  ADDRESS_POSTAL_CODE_REQUIRED = 'ADDRESS_POSTAL_CODE_REQUIRED',
  // `country` must be a 2-letter ISO code (upper-cased) — 400.
  ADDRESS_COUNTRY_INVALID = 'ADDRESS_COUNTRY_INVALID',
}

// One concrete throwable for the orders bounded context, carrying a typed `code`
// from `OrderErrorCodeEnum`. Satisfies the framework-free `DomainException` base's
// abstract `code` contract (ADR-025 pattern). Assert `err.code`, never string-match
// the message.
export class OrderDomainException extends DomainException {
  public readonly code: OrderErrorCodeEnum;

  constructor(code: OrderErrorCodeEnum, message: string) {
    super(message);
    this.code = code;
  }
}
