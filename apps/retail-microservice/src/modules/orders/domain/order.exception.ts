import { DomainException } from '@retail-inventory-system/common';

// Stable, greppable codes for every orders-context invariant violation — covering
// the `Order` root, its `OrderLine` children, the polymorphic `Address` aggregate,
// and the `Payment` aggregate (all four live in this one bounded-context module, so
// they share one throwable, the same one-class-per-module convention
// `CartDomainException` / `CatalogDomainException` / `PricingDomainException`
// follow). The code is the part
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
  // The order being read/operated on does not exist — 404. (Place reads a placed
  // order back for the idempotent repeat; the read/capture operations resolve an
  // order by id.)
  ORDER_NOT_FOUND = 'ORDER_NOT_FOUND',
  // The authenticated caller is neither the order's owner nor a staff override
  // (`order:read` for a read, `order:capture` for a capture) — the retail-side half
  // of the owner-or-staff check on the order read/capture paths (ADR-028 §7), 403.
  ORDER_ACCESS_FORBIDDEN = 'ORDER_ACCESS_FORBIDDEN',

  // --- Place Order flow (cart→order conversion) ---
  // The cart referenced by a place request does not exist — 404.
  ORDER_CART_NOT_FOUND = 'ORDER_CART_NOT_FOUND',
  // The authenticated caller is not the cart's owner — the retail-side half of the
  // owner-check (ADR-028 §7), 403.
  ORDER_CART_ACCESS_FORBIDDEN = 'ORDER_CART_ACCESS_FORBIDDEN',
  // The cart cannot be placed in its current state — it is `abandoned` (a purged
  // cart is terminal) — 409.
  ORDER_CART_NOT_PLACEABLE = 'ORDER_CART_NOT_PLACEABLE',
  // The cart has no lines, so there is nothing to place — 409.
  ORDER_CART_EMPTY = 'ORDER_CART_EMPTY',
  // A cart line's variant has no applicable price in the cart's currency at
  // place-time, so the line cannot be snapshotted at a real price — 409.
  ORDER_LINE_NO_PRICE = 'ORDER_LINE_NO_PRICE',
  // The payment gateway declined the authorize (unreachable with the always-approve
  // fake, but modeled) — the order stays placed-but-unpaid and the place surfaces a
  // 409.
  ORDER_PAYMENT_NOT_APPROVED = 'ORDER_PAYMENT_NOT_APPROVED',
  // The payment gateway declined the capture (unreachable with the always-capture
  // fake, but modeled, symmetric to `ORDER_PAYMENT_NOT_APPROVED`) — the payment stays
  // `authorized` and the capture surfaces a 409.
  ORDER_PAYMENT_NOT_CAPTURED = 'ORDER_PAYMENT_NOT_CAPTURED',

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

  // A payment's `orderId` must be a positive integer (the order it pays) — 400.
  PAYMENT_ORDER_ID_INVALID = 'PAYMENT_ORDER_ID_INVALID',
  // `amountMinor` must be a non-negative integer (minor units) — 400.
  PAYMENT_AMOUNT_INVALID = 'PAYMENT_AMOUNT_INVALID',
  // `currency` must be a non-empty string — 400.
  PAYMENT_CURRENCY_REQUIRED = 'PAYMENT_CURRENCY_REQUIRED',
  // The opaque gateway `method` token must be a non-empty string — 400.
  PAYMENT_METHOD_REQUIRED = 'PAYMENT_METHOD_REQUIRED',
  // The opaque `gatewayReference` must be a non-empty string — 400.
  PAYMENT_GATEWAY_REFERENCE_REQUIRED = 'PAYMENT_GATEWAY_REFERENCE_REQUIRED',
  // `capture()` was called on a payment that is not `authorized` — a well-formed
  // request the resource state forbids, 409.
  PAYMENT_INVALID_STATUS_TRANSITION = 'PAYMENT_INVALID_STATUS_TRANSITION',

  // --- Fulfillment / shipment flow (ADR-031) ---
  // The fulfillment being read/operated on does not exist — 404.
  FULFILLMENT_NOT_FOUND = 'FULFILLMENT_NOT_FOUND',
  // A fulfillment must carry at least one line — 400.
  FULFILLMENT_NO_LINES = 'FULFILLMENT_NO_LINES',
  // A fulfillment line quantity must be a positive integer — 400.
  FULFILLMENT_LINE_QUANTITY_INVALID = 'FULFILLMENT_LINE_QUANTITY_INVALID',
  // The requested per-`OrderLine` quantity would push the total shipped over the
  // ordered quantity (the cross-fulfillment sum invariant the Create use case
  // enforces — the aggregate cannot see sibling shipments) — 409.
  FULFILLMENT_QUANTITY_EXCEEDS_REMAINING = 'FULFILLMENT_QUANTITY_EXCEEDS_REMAINING',
  // A fulfillment status mutator was called from a state that does not allow it
  // (`ship` off non-`pending`, `markDelivered` off non-`shipped`, `cancel` off
  // non-`pending`) — a well-formed request the resource state forbids, 409.
  FULFILLMENT_INVALID_STATUS_TRANSITION = 'FULFILLMENT_INVALID_STATUS_TRANSITION',
  // `ship` was called without a tracking number — tracking is required to mark a
  // shipment `shipped` (the configurable default policy, ADR-031) — 400.
  FULFILLMENT_TRACKING_REQUIRED = 'FULFILLMENT_TRACKING_REQUIRED',

  // The order cannot be fulfilled in its current state — its lifecycle is not
  // `pending`/`confirmed` (a cancelled/shipped/delivered order), or its payment is
  // neither `authorized` nor `captured` (nothing was authorized to pay for the
  // shipment). An order-level precondition the Create Fulfillment use case checks
  // before any `Fulfillment` exists — distinct from a `Fulfillment` status-transition
  // breach (ADR-031) — 409.
  ORDER_NOT_FULFILLABLE = 'ORDER_NOT_FULFILLABLE',

  // --- Cancel Order / Cancel Line flow (ADR-031, drivers land later) ---
  // The order cannot be cancelled in its current state — it has a `shipped`/
  // `delivered` fulfillment, so cancellation would strand physically-shipped stock
  // — 409.
  ORDER_NOT_CANCELLABLE = 'ORDER_NOT_CANCELLABLE',
  // The order line referenced by a cancel-line request does not exist on the order
  // — 404.
  ORDER_LINE_NOT_FOUND = 'ORDER_LINE_NOT_FOUND',
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
