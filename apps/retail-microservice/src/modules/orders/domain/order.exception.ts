import { DomainException } from '@retail-inventory-system/common';

// Stable, greppable codes for every orders-context invariant violation — the `Order` root, its
// `OrderLine` children, the polymorphic `Address`, `Payment`, `Fulfillment` and `Refund`. **One
// throwable for all of them**, so a `catch` never has to enumerate exception types; the *code*, not
// the class, is what distinguishes a rejection.
//
// **The code → HTTP status table is `presentation/order-rpc-exception.filter.ts`, and it is not
// restated here.** The domain names *what went wrong*; the filter alone decides what that is worth
// over HTTP. A second copy of the mapping would drift from the one the code actually runs — this
// enum carried exactly that, member for member, until it was removed.
//
// What the comments below record is what a code name cannot: which rejections a *caller* can reach,
// which are internal breaches, and where two codes mean one thing to a client.
export enum OrderErrorCodeEnum {
  // The order currency must be a well-formed 3-letter code and is immutable
  // thereafter (no setter).
  ORDER_CURRENCY_INVALID = 'ORDER_CURRENCY_INVALID',
  // An order must carry at least one line.
  ORDER_NO_LINES = 'ORDER_NO_LINES',
  // A money total must be a non-negative integer (minor units).
  ORDER_MONEY_INVALID = 'ORDER_MONEY_INVALID',
  // The total invariant was violated: `grandTotalMinor = subtotalMinor +
  // taxTotalMinor + shippingTotalMinor − discountTotalMinor`, and `subtotalMinor =
  // Σ line.lineTotalMinor` — an internal consistency breach, never user input.
  ORDER_TOTAL_MISMATCH = 'ORDER_TOTAL_MISMATCH',
  // The optimistic-concurrency token must be a non-negative integer.
  ORDER_VERSION_INVALID = 'ORDER_VERSION_INVALID',
  // Optimistic-concurrency conflict on an order status write (ADR-036). Two
  // writers raced the same order (two staff editing one order, a capture racing.
  // ship of a sibling fulfillment) and the bounded retry budget was exhausted — the
  // root `version` moved under the writer on every attempt. The **member name** keeps
  // the `ORDER_` prefix (the module convention) but the **wire value** is the uniform
  // cross-service `VERSION_MISMATCH` — so a client branches on one code regardless of
  // which aggregate lost the race (cart / order / fulfillment / return) — and the
  // exception's `details.currentVersion` carries the row's now-current version so the
  // caller can refetch-and-retry (the cart `CART_VERSION_MISMATCH` / inventory
  // `STOCK_WRITE_CONFLICT` precedent). Distinct from a *cross-transition* domain
  // conflict (`ORDER_NOT_CANCELLABLE` / `FULFILLMENT_INVALID_STATUS_TRANSITION`),
  // which is the pessimistic-lock loser finding the state genuinely illegal after
  // serialization — both mean "you lost the race", but only the CAS loss is retried.
  ORDER_VERSION_MISMATCH = 'VERSION_MISMATCH',
  // A payment-status mutator was called from a state that does not allow it
  // (`markPaymentAuthorized` off non-`none`, `markPaymentCaptured` off
  // non-`authorized`) — a well-formed request the resource state forbids.
  ORDER_INVALID_PAYMENT_TRANSITION = 'ORDER_INVALID_PAYMENT_TRANSITION',
  // The order being read/operated on does not exist. (Place reads a placed
  // order back for the idempotent repeat; the read/capture operations resolve an
  // order by id.)
  ORDER_NOT_FOUND = 'ORDER_NOT_FOUND',
  // The authenticated caller is neither the order's owner nor a staff override
  // (`order:read` for a read, `order:capture` for a capture) — the retail-side half
  // of the owner-or-staff check on the order read/capture paths (ADR-028 §7).
  ORDER_ACCESS_FORBIDDEN = 'ORDER_ACCESS_FORBIDDEN',

  // --- Place Order flow (cart→order conversion) ---
  // The cart referenced by a place request does not exist.
  ORDER_CART_NOT_FOUND = 'ORDER_CART_NOT_FOUND',
  // The authenticated caller is not the cart's owner — the retail-side half of the
  // owner-check (ADR-028 §7).
  ORDER_CART_ACCESS_FORBIDDEN = 'ORDER_CART_ACCESS_FORBIDDEN',
  // The cart cannot be placed in its current state — it is `abandoned` (a purged
  // cart is terminal).
  ORDER_CART_NOT_PLACEABLE = 'ORDER_CART_NOT_PLACEABLE',
  // The cart has no lines, so there is nothing to place.
  ORDER_CART_EMPTY = 'ORDER_CART_EMPTY',
  // A cart line's variant has no applicable price in the cart's currency at
  // place-time, so the line cannot be snapshotted at a real price.
  ORDER_LINE_NO_PRICE = 'ORDER_LINE_NO_PRICE',
  // The payment gateway declined the authorize (unreachable with the always-approve
  // fake, but modeled) — the order stays placed-but-unpaid and the place surfaces the conflict.
  // 409.
  ORDER_PAYMENT_NOT_APPROVED = 'ORDER_PAYMENT_NOT_APPROVED',
  // The payment gateway declined the capture (unreachable with the always-capture
  // fake, but modeled, symmetric to `ORDER_PAYMENT_NOT_APPROVED`) — the payment stays
  // `authorized`.
  ORDER_PAYMENT_NOT_CAPTURED = 'ORDER_PAYMENT_NOT_CAPTURED',
  // The capture request named an `amountMinor` that is not the order's grand total.
  // **Partial capture does not exist here** — `IPaymentGatewayPort.capture(gatewayReference)`
  // takes no amount, so the full authorized figure is the only thing that can move. The field
  // used to be accepted and silently ignored: a client asking for 10.00 was charged 299.97 and
  // got a `200` that did not contradict it (ISSUE-09). Now it is rejected (422) rather than
  // honoured-in-name. The field survives so a real partial capture has somewhere to land.
  PARTIAL_CAPTURE_UNSUPPORTED = 'PARTIAL_CAPTURE_UNSUPPORTED',

  // --- Request-level idempotency (ADR-036) ---
  // Place Order was invoked with no `Idempotency-Key`. The header is required on the
  // money-/stock-moving write; the gateway rejects a missing header at the edge with
  // `IDEMPOTENCY_KEY_REQUIRED`, and this is the retail-side backstop for a direct RMQ
  // caller that bypassed the gateway.
  ORDER_IDEMPOTENCY_KEY_REQUIRED = 'ORDER_IDEMPOTENCY_KEY_REQUIRED',
  // The same `Idempotency-Key` was replayed with a *different* request body (a
  // different canonical fingerprint) — a client reused one key for two distinct
  // orders, surfaced loudly rather than silently honored with the wrong cached
  // response.
  ORDER_IDEMPOTENCY_KEY_REUSED = 'ORDER_IDEMPOTENCY_KEY_REUSED',
  // A concurrent request with the same `Idempotency-Key` is already in flight (the
  // reserve-first refund flow — ADR-036 concurrency hardening): the first submit atomically
  // reserved the key and is mid-execution, so this racing duplicate is turned away BEFORE
  // it can run the (non-idempotent) gateway refund a second time. The client refetches or
  // retries once the in-flight request completes (then it replays the stored result).
  ORDER_IDEMPOTENCY_KEY_IN_PROGRESS = 'ORDER_IDEMPOTENCY_KEY_IN_PROGRESS',

  // A line's opaque `variantId` must be a positive integer.
  ORDER_LINE_VARIANT_INVALID = 'ORDER_LINE_VARIANT_INVALID',
  // A line quantity must be a positive integer.
  ORDER_LINE_QUANTITY_INVALID = 'ORDER_LINE_QUANTITY_INVALID',
  // A line's snapshot `sku` must be a non-empty string.
  ORDER_LINE_SKU_REQUIRED = 'ORDER_LINE_SKU_REQUIRED',
  // A line's snapshot `nameSnapshot` must be a non-empty string.
  ORDER_LINE_NAME_REQUIRED = 'ORDER_LINE_NAME_REQUIRED',
  // A line money field must be a non-negative integer (minor units).
  ORDER_LINE_MONEY_INVALID = 'ORDER_LINE_MONEY_INVALID',
  // `lineTotalMinor` did not equal `unitPriceMinor × quantity + taxAmountMinor −
  // discountAmountMinor`.
  ORDER_LINE_TOTAL_MISMATCH = 'ORDER_LINE_TOTAL_MISMATCH',

  // An address `ownerType` must be one of the `AddressOwnerTypeEnum` values.
  ADDRESS_OWNER_TYPE_INVALID = 'ADDRESS_OWNER_TYPE_INVALID',
  // An address `ownerId` must be a non-empty string.
  ADDRESS_OWNER_ID_REQUIRED = 'ADDRESS_OWNER_ID_REQUIRED',
  // `recipientName` must be a non-empty string.
  ADDRESS_RECIPIENT_REQUIRED = 'ADDRESS_RECIPIENT_REQUIRED',
  // `line1` must be a non-empty string.
  ADDRESS_LINE1_REQUIRED = 'ADDRESS_LINE1_REQUIRED',
  // `city` must be a non-empty string.
  ADDRESS_CITY_REQUIRED = 'ADDRESS_CITY_REQUIRED',
  // `region` must be a non-empty string.
  ADDRESS_REGION_REQUIRED = 'ADDRESS_REGION_REQUIRED',
  // `postalCode` must be a non-empty string.
  ADDRESS_POSTAL_CODE_REQUIRED = 'ADDRESS_POSTAL_CODE_REQUIRED',
  // `country` must be a 2-letter ISO code (upper-cased).
  ADDRESS_COUNTRY_INVALID = 'ADDRESS_COUNTRY_INVALID',

  // A payment's `orderId` must be a positive integer (the order it pays).
  PAYMENT_ORDER_ID_INVALID = 'PAYMENT_ORDER_ID_INVALID',
  // `amountMinor` must be a non-negative integer (minor units).
  PAYMENT_AMOUNT_INVALID = 'PAYMENT_AMOUNT_INVALID',
  // `currency` must be a non-empty string.
  PAYMENT_CURRENCY_REQUIRED = 'PAYMENT_CURRENCY_REQUIRED',
  // The opaque gateway `method` token must be a non-empty string.
  PAYMENT_METHOD_REQUIRED = 'PAYMENT_METHOD_REQUIRED',
  // The opaque `gatewayReference` must be a non-empty string.
  PAYMENT_GATEWAY_REFERENCE_REQUIRED = 'PAYMENT_GATEWAY_REFERENCE_REQUIRED',
  // `capture()` was called on a payment that is not `authorized` — a well-formed
  // request the resource state forbids.
  PAYMENT_INVALID_STATUS_TRANSITION = 'PAYMENT_INVALID_STATUS_TRANSITION',

  // --- Fulfillment / shipment flow (ADR-031) ---
  // The fulfillment being read/operated on does not exist.
  FULFILLMENT_NOT_FOUND = 'FULFILLMENT_NOT_FOUND',
  // A fulfillment must carry at least one line.
  FULFILLMENT_NO_LINES = 'FULFILLMENT_NO_LINES',
  // A fulfillment line quantity must be a positive integer.
  FULFILLMENT_LINE_QUANTITY_INVALID = 'FULFILLMENT_LINE_QUANTITY_INVALID',
  // The requested per-`OrderLine` quantity would push the total shipped over the
  // ordered quantity (the cross-fulfillment sum invariant the Create use case
  // enforces — the aggregate cannot see sibling shipments).
  FULFILLMENT_QUANTITY_EXCEEDS_REMAINING = 'FULFILLMENT_QUANTITY_EXCEEDS_REMAINING',
  // A fulfillment status mutator was called from a state that does not allow it
  // (`ship` off non-`pending`, `markDelivered` off non-`shipped`, `cancel` off
  // non-`pending`) — a well-formed request the resource state forbids.
  FULFILLMENT_INVALID_STATUS_TRANSITION = 'FULFILLMENT_INVALID_STATUS_TRANSITION',
  // `ship` was called without a tracking number — tracking is required to mark.
  // shipment `shipped` (the configurable default policy, ADR-031).
  FULFILLMENT_TRACKING_REQUIRED = 'FULFILLMENT_TRACKING_REQUIRED',
  // `Order.advanceFulfillment` was asked to move the order's fulfillment axis
  // strictly backward along `unfulfilled → partially-shipped → shipped → delivered`
  // (e.g. `shipped → partially-shipped`) — a well-formed request the resource state
  // forbids, distinct from a per-shipment `FULFILLMENT_INVALID_STATUS_TRANSITION`
  // because this guards the *order header's* roll-up axis the Ship/Deliver operations
  // advance (ADR-031).
  ORDER_INVALID_FULFILLMENT_TRANSITION = 'ORDER_INVALID_FULFILLMENT_TRANSITION',

  // The order cannot be fulfilled in its current state — its lifecycle is not
  // `pending`/`confirmed` (a cancelled/shipped/delivered order), or its payment is
  // neither `authorized` nor `captured` (nothing was authorized to pay for the
  // shipment). An order-level precondition the Create Fulfillment use case checks
  // before any `Fulfillment` exists — distinct from a `Fulfillment` status-transition
  // breach (ADR-031).
  ORDER_NOT_FULFILLABLE = 'ORDER_NOT_FULFILLABLE',

  // --- Cancel Order / Cancel Line flow (ADR-031) ---
  // The order cannot be cancelled in its current state — it has a `shipped`/
  // `delivered` fulfillment, so cancellation would strand physically-shipped stock.
  ORDER_NOT_CANCELLABLE = 'ORDER_NOT_CANCELLABLE',
  // The order line referenced by a cancel-line request does not exist on the order.
  ORDER_LINE_NOT_FOUND = 'ORDER_LINE_NOT_FOUND',

  // --- Refund flow (ADR-032) ---
  // A refund `amountMinor` must be a **strictly positive** integer (minor units) — a
  // zero/negative refund is meaningless, unlike `Payment.amountMinor` which allows 0,
  // so this is a refund-specific code rather than `PAYMENT_AMOUNT_INVALID`.
  REFUND_AMOUNT_INVALID = 'REFUND_AMOUNT_INVALID',
  // A refund `reason` must be a non-empty string.
  REFUND_REASON_REQUIRED = 'REFUND_REASON_REQUIRED',
  // A refund status mutator was called from a state that does not allow it
  // (`markIssued` / `markFailed` off non-`pending`) — a well-formed request the
  // resource state forbids.
  REFUND_INVALID_STATUS_TRANSITION = 'REFUND_INVALID_STATUS_TRANSITION',
  // The refund being read/operated on does not exist.
  REFUND_NOT_FOUND = 'REFUND_NOT_FOUND',
  // The requested refund amount would push the cumulative refunded total past the
  // payment's captured amount (`amount > Payment.amountMinor −
  // Payment.refundedAmountMinor`) — the over-refund ceiling the Issue Refund use case
  // enforces (the aggregate cannot see `Payment`).
  REFUND_EXCEEDS_REFUNDABLE = 'REFUND_EXCEEDS_REFUNDABLE',
  // Only captured money can be given back. An authorized-but-uncaptured payment is voided, not
  // refunded — nothing was ever taken.
  REFUND_PAYMENT_NOT_CAPTURED = 'REFUND_PAYMENT_NOT_CAPTURED',
  // Distinct from `ORDER_ACCESS_FORBIDDEN` so the refund surface can say why in its own words.
  //
  // **Note the asymmetry with returns:** a non-owner reading someone else's refunds is REFUSED here,
  // while `list-returns` returns an empty list for the same shape of request. One confirms the
  // order exists; the other does not. Nothing records which was intended.
  REFUND_ACCESS_FORBIDDEN = 'REFUND_ACCESS_FORBIDDEN',
}

// One concrete throwable for the orders bounded context, carrying a typed `code`
// from `OrderErrorCodeEnum`. Satisfies the framework-free `DomainException` base's
// abstract `code` contract (ADR-025 pattern). Assert `err.code`, never string-match
// the message.
export class OrderDomainException extends DomainException {
  public readonly code: OrderErrorCodeEnum;
  // Optional structured payload forwarded through the RPC filter and the gateway
  // error util (the cart `{ currentVersion }` / inventory `{ available }` precedent),
  // so a client branches on data rather than parsing the human message. The OCC
  // conflict carries `{ currentVersion }` here so the caller can refetch-and-retry.
  // Frozen-shaped (`Readonly`) because it is read, never mutated, downstream.
  public readonly details?: Readonly<Record<string, unknown>>;

  constructor(
    code: OrderErrorCodeEnum,
    message: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
