# Retail orders

What the retail `orders` module (`apps/retail-microservice/src/modules/orders/`) does today, beyond
what its names and types say: the five aggregates, the order use cases, and how they fail. Paths
below are relative to that folder unless they start at the repository root. The rationale lives in
the ADRs: [ADR-028](../adr/028-cart-order-payment-and-address-chain.md) (the chain and the three
status axes), [ADR-031](../adr/031-fulfillment-aggregate-and-ship-triggered-capture.md)
(fulfillment and ship-triggered capture),
[ADR-032](../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md) (refunds),
[ADR-036](../adr/036-idempotency-key-store-and-enforced-occ.md) and
[ADR-045](../adr/045-one-occ-retry-protocol.md) (idempotency keys and OCC),
[ADR-040](../adr/040-persisted-cancelled-quantity-on-order-line.md) (`cancelled_quantity`),
[ADR-052](../adr/052-claim-before-you-charge.md) (the capture claim),
[ADR-056](../adr/056-lifting-the-post-commit-retry-helper.md) /
[ADR-057](../adr/057-cancel-allocation-needs-an-operation-identity.md) (post-commit retries), and
[ADR-063](../adr/063-unit-of-work-for-stock-orders-returns.md), which tabulates the transaction shape
of every use case below. Payload and view rules are in
[`wire-contracts.md`](wire-contracts.md#retail--orders-payments-fulfillments-refunds); the
code-to-status table is `presentation/order-rpc-exception.filter.ts`.

## Aggregates

### `Order` and `OrderLine`

- `Order.place` derives the totals from the lines and opens the order `pending` / `none` /
  `unfulfilled` at version 0. The `orderNumber` it carries is the placeholder `'PENDING'`
  (`PlaceOrderUseCase`, `PROVISIONAL_ORDER_NUMBER`); the repository replaces it with
  `ORD-<year>-<pad8(id)>` on the first insert, so only the re-read order has the real number
  (`infrastructure/persistence/order-typeorm.repository.ts`, `OrderTypeormRepository.save`).
- Loading an order re-checks every invariant the constructors check: `subtotalMinor = Σ lineTotalMinor`,
  the grand-total formula, each line's total formula, and `0 ≤ cancelledQuantity ≤ quantity`. A stored
  row that breaks one fails the read with `ORDER_TOTAL_MISMATCH`, `ORDER_LINE_TOTAL_MISMATCH` or
  `ORDER_LINE_QUANTITY_INVALID` instead of loading (`Order.reconstitute`, the `OrderLine`
  constructor, `domain/order.model.ts`, `domain/order-line.model.ts`).
- `Order.currency` must be three ASCII letters in any case (`/^[A-Za-z]{3}$/`) and is kept as given —
  unlike `Address.country`, it is not upper-cased (`Order` constructor, `CURRENCY_PATTERN`).
- The payment axis moves only `none → authorized` (`markPaymentAuthorized`), `none → failed`
  (`markPaymentFailed`) and `authorized → captured` (`markPaymentCaptured`). Nothing moves it out of
  `captured` or `failed`.
- `Order.cancel` accepts `pending` or `confirmed` and changes the lifecycle axis only. A cancelled
  order whose payment row was voided still reads `paymentStatus: 'authorized'`, and one whose payment
  was flagged for refund reads `'captured'`: read the `payment` row to learn what happened to the
  money.
- `Order.advanceFulfillment` accepts any move that does not go backward along
  `unfulfilled → partially-shipped → shipped → delivered`, so a single full ship goes straight from
  `unfulfilled` to `shipped`, and a repeat of the current value is allowed. A backward move is
  `ORDER_INVALID_FULFILLMENT_TRANSITION`.
- `Order.markDelivered` needs the fulfillment axis at `partially-shipped` or `shipped` and a lifecycle
  that is not `cancelled`, and sets both `status` and `fulfillmentStatus` to `delivered` in one
  version bump.
- `Order.cancelLineQuantity` bumps the order's version, so two Cancel Line calls on one order
  contend on the order's compare-and-swap even when they target different lines.
- `OrderLine.cancelQuantity` refuses more than `activeQuantity` with
  `FULFILLMENT_QUANTITY_EXCEEDS_REMAINING`, whatever the caller computed. That bound is what caps the
  allocation a cancel can release.
- `OrderLine.markFulfillment` treats a move to the current status as a no-op. A backward move, or a
  target outside `allocated` / `partially-shipped` / `shipped`, throws a plain `Error` (a `500`, not a
  domain code): the use cases never produce one, and Ship skips a line whose `activeQuantity` is `0`
  instead of calling it (`ShipFulfillmentUseCase.advanceLinesAndRollUp`).

### `Payment`

- An order has at most one payment: only `AuthorizePaymentUseCase` creates one. `findByOrderId`
  returns the row with the highest id (`infrastructure/persistence/payment-typeorm.repository.ts`).
- The `payment` table has no version column. Every `save` writes the whole row from the in-memory
  object, so the last writer wins (`PaymentTypeormRepository.save`). The capture claim and Cancel
  Order take a `SELECT … FOR UPDATE` first; Issue Refund does not (see
  [Failure modes](#failure-modes)).
- `flaggedForRefund` is independent of `status`. A full refund sets `refunded` and clears the flag; a
  partial refund leaves the payment `captured` with the flag still set (`Payment.refund`).
- `Payment.refund` rejects a non-positive amount, and an amount beyond what is left to refund, with
  a plain `Error`. Issue Refund checks both first, so a caller never
  reaches those throws.
- `Payment.void` changes the row only. `IPaymentGatewayPort` has `authorize`, `capture` and `refund`
  and no void (`application/ports/payment-gateway.port.ts`), so cancelling an authorized order
  releases nothing at the processor. With the bound `FakePaymentGatewayAdapter` there is nothing to
  release.
- `Payment.releaseCapture` is called only after the gateway declines a capture, from Capture Payment
  and from Ship's `captureIfNeeded`. Nothing else moves a payment out of `capturing`.

### `Fulfillment`

- Create Fulfillment uses `INVENTORY_DEFAULT_STOCK_LOCATION` when the request names no
  `stockLocationId` (`CreateFulfillmentUseCase.execute`).
- `Fulfillment.ship` needs a non-blank `trackingNumber` (`FULFILLMENT_TRACKING_REQUIRED`); `carrier`
  may be null.
- `listByOrderId` orders by `shipped_at DESC, id DESC`. MySQL sorts `NULL` lowest, so every
  fulfillment that never shipped (`pending`, `cancelled`) comes after the shipped ones
  (`infrastructure/persistence/fulfillment-typeorm.repository.ts`).

### `Refund`

- A refund's `amountMinor` must be positive (`REFUND_AMOUNT_INVALID`), unlike a payment's, which may
  be `0`. Its `currency` is the order's (`IssueRefundUseCase.issue`).
- The model does not know the refundable ceiling. `IssueRefundUseCase` is the only thing that checks
  it; a `Refund` built anywhere else is unchecked.
- `findByOrderId` orders by `issued_at DESC, id DESC`, so `pending` and `failed` refunds (no
  `issued_at`) come after the issued ones (`infrastructure/persistence/refund-typeorm.repository.ts`).

## Who may call what

Retail checks the caller itself and does not rely on the gateway alone. Most order use cases go
through `loadAuthorizedOrder` (`application/use-cases/order-access.ts`):

1. No order with that id: `ORDER_NOT_FOUND`.
2. Otherwise the caller passes if `order.customerId === actorId`, or if the staff flag in the payload
   is `true`. Anyone else gets `ORDER_ACCESS_FORBIDDEN`.

The staff flag is a boolean the gateway computes from the caller's `permissions` claim. A customer
token has no such claim, so a customer is always judged on ownership. A missing order and a foreign
order are told apart (`404` against `403`), per
[ADR-051](../adr/051-refusing-a-resource-you-do-not-own.md).

| Use case                                             | Retail-side check                                                             | Staff flag computed from | HTTP route gate (`README.md` §6)                     |
| ---------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------- |
| Get Order, List Fulfillments                         | `loadAuthorizedOrder`                                                         | `order:read`             | none — owner or staff                                |
| Capture Payment                                      | `loadAuthorizedOrder`                                                         | `order:capture`          | none — **the owning customer can capture**           |
| Cancel Order                                         | `loadAuthorizedOrder`                                                         | `order:cancel`           | none — owner or staff                                |
| Create Fulfillment, Ship Fulfillment, Mark Delivered | `loadAuthorizedOrder`                                                         | `order:fulfill`          | `@RequiresPermission('order:fulfill')`               |
| Cancel Line                                          | order exists, then the flag alone (`ORDER_ACCESS_FORBIDDEN`)                  | `order:cancel`           | `@RequiresPermission('order:cancel')`                |
| List Refunds                                         | inline owner-or-staff check, answering `REFUND_ACCESS_FORBIDDEN`              | `order:read`             | none — owner or staff                                |
| Issue Refund                                         | **none** — the use case trusts `actorId`                                      | —                        | `@RequiresPermission('order:refund')`, the only gate |
| List My Orders                                       | none needed: the query is scoped to the payload's `customerId`                | —                        | bearer only                                          |
| Place Order                                          | the cart's `customerId` must equal the caller (`ORDER_CART_ACCESS_FORBIDDEN`) | —                        | bearer only                                          |

So Create, Ship and Deliver are staff-only over HTTP, but the retail RPCs still admit the order's
owner: a direct `retail.fulfillment.ship` from the owning customer's id passes. Nothing lists all
orders: List My Orders has no staff override, so a staff member sees only orders placed under its
own id.

## Use cases

### Place Order

`application/use-cases/place-order.use-case.ts`, `PlaceOrderUseCase`.

- **Order of checks:** missing `idempotencyKey` → the store lookup (replay, or `422`) → cart missing
  (`ORDER_CART_NOT_FOUND`) → not the caller's cart → `converted` (see below) → `abandoned`
  (`ORDER_CART_NOT_PLACEABLE`) → no lines (`ORDER_CART_EMPTY`) → the catalog snapshot.
- The catalog snapshot fetches every line's variant and price concurrently, before the transaction.
  The first rejection wins, and a line with no price in the cart's currency is
  `ORDER_LINE_NO_PRICE` (`snapshotLines`).
- `nameSnapshot` is the product name, followed by the variant's option values in brackets:
  `Aurora Desk Lamp (color: warm-white)`. The keys are sorted with `localeCompare`, and a variant
  with no option values gets the bare name (`composeName`).
- Inside the transaction the order is inserted with null address ids. The two address rows are then
  written with `ownerId = String(orderId)`, and `attachAddresses` patches the pointers. Next come the
  cart CAS and the allocate RPC.
- The cart CAS (`markConverted`) matching no `active` row throws `ORDER_CART_NOT_PLACEABLE`. The
  transaction rolls back and nothing is allocated. This covers a concurrent place, and also a cart
  abandoned since the state check.
- **Two compensations, for two windows:**

  | Window                                                    | What runs                                                                                                                                                                                  | Movement `reason`        |
  | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
  | the allocate committed, then the place commit failed      | `cancelAllocation`, best effort (a failure is logged at `warn`); the original error is rethrown                                                                                            | `place-rollback`         |
  | the place committed, then `AuthorizePaymentUseCase` threw | `compensateDeclinedAuthorization`: `cancelAllocation`, then one transaction doing `markPaymentFailed()` + `cancel()`; each step logs at `error` on failure; the original error is rethrown | `authorization-declined` |

  Each compensation mints a fresh `operationKey`. The second window runs on **any** error from the
  authorize step, not only a decline. It emits nothing, because `retail.order.placed` has not fired
  yet, and it leaves the cart `converted`.

- **A `converted` cart does not mean a paid order** (`resolveExistingOrder`). A re-place under a new
  key returns the order found by `source_cart_id` only if that order has a `payment` row. With no
  payment row, whether the order was declined or the process died before the authorize, the answer
  is `ORDER_PAYMENT_NOT_APPROVED`, and the cart cannot be placed again. A `converted` cart with no
  order at all throws a plain `Error` (`500`).
- The idempotency record is written only after a successful place, outside the transaction. A place
  that throws stores nothing, so a retry under the same key runs again and meets the cart guard.

### Capture Payment

`application/use-cases/capture-payment.use-case.ts`, `CapturePaymentUseCase`.

- **Order of checks:** key → store → `loadAuthorizedOrder` → no payment row
  (`ORDER_INVALID_PAYMENT_TRANSITION`) → already `captured` (returns the current view, no gateway
  call) → any status other than `authorized` (`PAYMENT_INVALID_STATUS_TRANSITION`) → `amountMinor`.
  A `capturing` payment, meaning a capture is in flight elsewhere, is refused at the status check.
- `amountMinor` is compared only when it is a number, so `null` counts as omitted, like `undefined`
  (the `@IsOptional()` trap, see `SweepExpiredReservationsUseCase.resolveLimit`).
- If the locked read in the claim transaction finds the payment already `captured`, a concurrent
  capture finished first. The use case then returns the winner's order and payment with no charge
  (`AlreadyCapturedSignal`), the same answer as the unlocked fast path.
- `retail.payment.captured` carries the payment row's `amountMinor`. Its `occurredAt` is the
  gateway's capture time.

### Ship Fulfillment

`application/use-cases/ship-fulfillment.use-case.ts`, `ShipFulfillmentUseCase`.

- **Order of checks:** key → store → `loadAuthorizedOrder` → the fulfillment exists **on this order**
  (a fulfillment of another order is `FULFILLMENT_NOT_FOUND`) → `pending` → a non-blank
  `trackingNumber`, checked before any money moves → a payment row exists
  (`ORDER_INVALID_PAYMENT_TRANSITION`).
- `captureIfNeeded` skips the gateway for a payment already `captured`. Otherwise it claims, charges,
  and on a decline releases the claim and throws `ORDER_PAYMENT_NOT_CAPTURED`.
- Inside the retried transaction, `completeCapture` runs only while the re-read payment is still
  `capturing`. A retried attempt therefore finds it `captured` and does not call it a second time.
- **Roll-up:**
  - Shipped units per order line are summed over the order's `shipped` and `delivered` fulfillments;
    a `pending` sibling does not count.
  - A line with `activeQuantity` `0` is skipped.
  - Otherwise a line becomes `shipped` when its shipped units reach `activeQuantity`, and
    `partially-shipped` when some but not all have shipped.
  - The order becomes `shipped` only if every line that still owes units is fully shipped, otherwise
    `partially-shipped`.
- After the commit, `inventory.stock.commit-sale` gets one line per fulfillment line: the variant of
  its order line, the **fulfillment's** `stockLocationId`, the fulfillment line's quantity, and
  `fulfillmentId` as a string. Its retry and replay are covered in
  [`shared-libraries.md`](shared-libraries.md#retrythenlogforreplay).
- The events go out after the Commit Sale attempts finish: always `retail.fulfillment.shipped`, plus
  `retail.payment.captured` only when this ship took the money. On that path the captured event is
  built from the payment as read before the claim, which has no `capturedAt`. Its `occurredAt` is
  therefore the emit time, not the gateway's capture time.

### Mark Delivered

`application/use-cases/mark-delivered.use-case.ts`, `MarkDeliveredUseCase`.

- The fulfillment must belong to the order and be `shipped`. It is re-read `FOR UPDATE`, so of two
  concurrent Delivers of one fulfillment exactly one succeeds and emits.
- The order rolls up to `delivered` when every fulfillment that is not `cancelled` is `delivered`.
  The order's lines are not consulted. An order whose remaining units were never planned into a
  fulfillment still becomes `delivered`. After that, Create Fulfillment refuses it
  (`ORDER_NOT_FULFILLABLE`) and Cancel Order refuses it (a `delivered` fulfillment exists). Only
  Cancel Line can still release the unplanned units' allocation.

### Cancel Order

`application/use-cases/cancel-order.use-case.ts`, `CancelOrderUseCase`.

- A shipped or delivered fulfillment is checked twice: once before the transaction as a fast fail,
  and again inside it on fulfillments re-read one by one `FOR UPDATE`. Either check fails with
  `ORDER_NOT_CANCELLABLE`.
- `Order.cancel` refuses an order that is not `pending` or `confirmed`. Cancelling twice, or
  cancelling an order the declined-authorization compensation already cancelled, is
  `ORDER_NOT_CANCELLABLE`.
- The payment is re-read `FOR UPDATE`:

  | Payment status                  | Cancel Order                                                      |
  | ------------------------------- | ----------------------------------------------------------------- |
  | `capturing`                     | refuses the whole cancel: `ORDER_NOT_CANCELLABLE`                 |
  | `captured`                      | `flagForRefund()`; the event says `paymentFlaggedForRefund: true` |
  | `authorized`                    | `void()`                                                          |
  | `voided`, `refunded`, or no row | left as it is                                                     |

- The allocation release after the commit covers only lines with `activeQuantity > 0`, at that
  quantity. If no line qualifies, no RPC is sent at all, because inventory rejects an empty `lines`
  array (`buildCancelAllocationPayload`). The quantities come from the order as read **before** the
  transaction (see [Failure modes](#failure-modes)).

### Cancel Line

`application/use-cases/cancel-line.use-case.ts`, `CancelLineUseCase`.

- The cancellable amount is the line's `activeQuantity` minus its quantity in every fulfillment
  that is not `cancelled`. Planned `pending` shipments count, so a line fully planned into a pending fulfillment
  has nothing to cancel until that fulfillment is cancelled. An omitted `quantity` means all of it,
  and a result of `0` is `FULFILLMENT_QUANTITY_EXCEEDS_REMAINING`.
- **The order's lifecycle status is not checked.** Neither the use case nor `Order.cancelLineQuantity`
  looks at `status`, so Cancel Line runs on a `cancelled` or `delivered` order too, and releases what
  it cancels.
- The release after the commit is one line: the variant, at `INVENTORY_DEFAULT_STOCK_LOCATION`, with
  movement `reason` `line-cancelled`.

### Create Fulfillment

`application/use-cases/create-fulfillment.use-case.ts`, `CreateFulfillmentUseCase`.

- The order must be `pending` or `confirmed`, and its payment axis `authorized` or `captured`.
  Otherwise the answer is `ORDER_NOT_FULFILLABLE`.
- Requested quantities are first summed per `orderLineId`. Each total must fit within the
  line's `activeQuantity` minus its quantity in the non-cancelled fulfillments, or the answer is
  `FULFILLMENT_QUANTITY_EXCEEDS_REMAINING`. An `orderLineId` not on the order is
  `ORDER_LINE_NOT_FOUND`.
- The check reads the fulfillments with no lock and no transaction, and the insert follows as a
  separate write (see [Failure modes](#failure-modes)).

### Issue Refund

`application/use-cases/issue-refund.use-case.ts`, `IssueRefundUseCase`.

- **Order of checks:**
  1. key, then `reserve` (replay, `422`, or `409 ORDER_IDEMPOTENCY_KEY_IN_PROGRESS`);
  2. order missing (`ORDER_NOT_FOUND`);
  3. payment missing or on another order (`REFUND_PAYMENT_NOT_CAPTURED`);
  4. **the already-issued match**;
  5. payment not `captured` (`REFUND_PAYMENT_NOT_CAPTURED`);
  6. the ceiling (`REFUND_EXCEEDS_REFUNDABLE`).
- **The already-issued match is on `(paymentId, amountMinor, reason)`**, not on the key
  (`findIssuedDuplicate`). An `issued` refund with the same three values is returned as is: no
  gateway call, no audit row, no event. That includes a request under a new key. Two genuine refunds
  of the same amount for the same reason therefore collapse into one; the second needs a different
  `reason` text.
- The `pending` refund row is saved in its own transaction before the gateway call. The payment and
  refund updates after an approval share one transaction. A decline saves the refund `failed` and
  leaves the payment as it was.
- If the refund work throws, the reservation is released, so a retry runs again. If `finalize`
  fails after a successful refund, the reservation is released too, and the success is still
  returned. A retry then runs again and hits the already-issued match.
- The audit row is awaited and written for issued and failed refunds alike: `actorKind: 'staff'`,
  `targetKind: null`, `targetId` the order id, with the payment's status and `refundedAmountMinor`
  before and after in the payload (`writeAudit`). The auto-refund from `OrderCancelledConsumer` calls
  `execute` directly with `actorId: null`.

### Reports and housekeeping

- `ReportStaleCaptureClaimsUseCase` logs, at `error`, every `capturing` payment whose `updated_at` is
  older than `now − CAPTURE_CLAIM_STALE_MINUTES`, then a total line. It keeps no memory, so every
  tick reports the same rows again. No route, RPC or port method moves a payment out of
  `capturing` except the capture flows themselves, so resolving a stranded claim is a manual change
  in the database (`application/use-cases/report-stale-capture-claims.use-case.ts`).
- List My Orders defaults `page` to `1` and `pageSize` to `20`, and caps `pageSize` at `100`; a
  non-integer or non-positive value falls back to the default. Its items carry no `payment`, whereas
  Get Order includes one (`ListMyOrdersUseCase`, `GetOrderUseCase`).

## Events and the buyer's email

- Every buyer-facing event (`retail.order.placed`, `retail.fulfillment.shipped` / `.delivered`,
  `retail.order.cancelled`, `retail.refund.issued`) carries a `customerEmail` resolved at emit time
  from the order's `customerId`, and `customerLocale: null`.
- `resolveCustomerEmail` returns `null` without a read for a null `customerId`, and turns a reader
  error into a `warn` and `null`. It never throws
  (`application/use-cases/resolve-customer-email.ts`).
- The notification consumers skip an event whose `customerEmail` is null, logging at `warn`. A reader
  hiccup at emit time therefore means the buyer gets no email for that event
  (`apps/notification-microservice/src/modules/notifications/infrastructure/consumers/dispatch-customer-email.ts`).

## Failure modes

- **Money moved, recording failed.** On the capture and ship paths, if the gateway approved but the
  transaction recording it fails, the payment stays `capturing` while the money has moved. The
  failure can be an exhausted OCC retry, surfaced to the caller as `409 VERSION_MISMATCH`, or a
  crash. Cancel Order refuses the order, and Capture and Ship refuse the payment
  (`PAYMENT_INVALID_STATUS_TRANSITION`). Only the stale-claim report surfaces it, after
  `CAPTURE_CLAIM_STALE_MINUTES`.
- **Authorization approved, recording failed.** If the gateway approved the authorize but
  `AuthorizePaymentUseCase`'s transaction failed, Place's compensation still releases the stock and
  marks the order `failed` and `cancelled`. At a real processor that authorization would stay open,
  and nothing voids it.
- **A compensation fails.** If `compensateDeclinedAuthorization` cannot mark the order, it stays
  `pending` / `none` with its stock allocated until someone intervenes. Re-placing its cart is
  refused with `ORDER_PAYMENT_NOT_APPROVED`, and the cause is in the `error` log.
- **Concurrent refunds under different keys.** Issue Refund reads the payment with no lock and
  writes it back whole, and the row has no version. Two refunds of one payment running at the same
  time under different keys can both pass the ceiling and both call the gateway, and the later
  write's `refunded_amount_minor` overwrites the earlier one. `reserve` serialises only requests
  that share a key.
- **Concurrent Create Fulfillment.** Two creates for the same line that run at the same time can
  both pass the remaining-quantity check and together plan more units than `activeQuantity`.
- **Over-release by Cancel Order.** Cancel Order builds its release from the order it read before
  its transaction. A Cancel Line that commits in between has its units released a second time.
- **Over-release by Cancel Line.** A Cancel Line on an order that is already cancelled, including
  one cancelled by the declined-authorization compensation, releases units that were already
  released.
- **How an over-release shows.** Inventory refuses a release only when it exceeds the whole
  `quantity_allocated` of that `(variant, location)`, which all orders share
  (`StockLevel.releaseAllocated`). Below that, an over-release silently eats other orders'
  allocations.
- A failed release or Commit Sale after a commit is retried and then logged for replay; the local
  write is never rolled back ([`shared-libraries.md`](shared-libraries.md#retrythenlogforreplay)).
