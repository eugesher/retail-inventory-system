# Retail orders

What the retail `orders` module (`apps/retail-microservice/src/modules/orders/`) does today, beyond
what its names and types say: the five aggregates, the order use cases, how they are stored and
wired, and how they fail. Paths below are relative to that folder unless they start at the
repository root. The rationale lives in
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
  `ORD-<year>-<pad8(id)>` inside the insert's transaction (see [Writes](#writes)), so only the
  re-read order has the real number
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

## Persistence

Paths in this section are under `infrastructure/persistence/` unless they say otherwise.

### Reads, locks and versions

- **A read inside a transaction sees that transaction's snapshot.** Nothing in `libs/database` changes
  InnoDB's default `REPEATABLE READ`, so `findById`, `findByOrderId` and `listByOrderId` called with a
  scope do not see a row that another transaction commits later. The two locking reads,
  `FulfillmentTypeormRepository.findByIdForUpdate` and `PaymentTypeormRepository.findByOrderIdForUpdate`,
  are `SELECT … FOR UPDATE`: they wait for a concurrent writer and return what it committed. Both
  require a scope, because the lock ends with the transaction. The fulfillment read also locks the
  `fulfillment_line` rows it joins.
- **Only the order is version-checked.** `OrderTypeormRepository.save` with an `expectedVersion`
  issues one `UPDATE` of every root column plus `version = version + 1`, under
  `WHERE id = ? AND version = ?`. The lines are written only after that succeeds. When it matches no
  row, `save` reads the row's current version on the default manager, outside the rolled-back
  transaction, and throws `OrderWriteConflictError` carrying it. `runWithOrderWriteRetry` retries on
  that, and when the retries run out the caller gets `409 VERSION_MISMATCH` with
  `details.currentVersion`.
  - Without `expectedVersion` the write is TypeORM's managed `save`: it writes the whole root and
    compares nothing. On an existing order only `AuthorizePaymentUseCase` calls it that way.
  - `fulfillment.version` goes up on every save and nothing ever compares it. Fulfillment
    transitions are serialised by `findByIdForUpdate` instead. `payment`, `refund` and `address` have
    no version column.
- **An order's `version` also moves on internal writes.** TypeORM appends `version = version + 1` to
  every `Repository.update` that does not set the version itself (`UpdateQueryBuilder` in
  `typeorm` 0.3.28). The `order_number` finalize and `attachAddresses` therefore each bump it, so a
  newly placed order is already several versions past its insert.

### Writes

- **A new order is inserted with a provisional `order_number`**: `TMP-` plus 16 hex characters, which
  exactly fills `order_number VARCHAR(20)`. The same transaction then sets `ORD-<year>-<pad8(id)>`,
  where `year` is the UTC year of `placedAt`, so the provisional value never commits
  (`OrderTypeormRepository.persistGraph`).
- **An order re-save rewrites every line row**, because a line's `status` moves as shipments go out.
  A fulfillment re-save writes the root only, since its lines never change after creation
  (`FulfillmentTypeormRepository.persistGraph`).
- **An `address` row is always an order snapshot.** Place writes `owner_type = 'order'` with
  `owner_id = String(orderId)`. Nothing writes a `customer`-owned address, and `owner_id` has no
  foreign key (`AddressTypeormRepository.save`, `domain/address.model.ts`).
- **An entity is registered by adding it to `orderEntities`** (`infrastructure/persistence/index.ts`).
  `orders.module.ts` passes that array to `DatabaseModule.forFeature`, and the retail
  `app/app.module.ts` spreads it into the connection. `IdempotencyKeyEntity` lives in
  `infrastructure/idempotency/` but is registered through the same array.

### The cart and customer tables

- **The cart is read with raw SQL, outside the place transaction and with no lock.**
  `CartReaderTypeormAdapter.findCart` filters `deleted_at IS NULL` on `cart` and on `cart_line`.
  `markConverted` then runs on the place transaction as
  `UPDATE cart SET status = 'converted', version = version + 1 … WHERE id = ? AND status = 'active'`.
  It compares the status and not the version. It does bump the version, so a cart-side writer holding
  the old version fails its own compare-and-swap afterwards.
- **The customer's email is read with no status filter** (`customer-contact-reader.typeorm.adapter.ts`,
  `SELECT email FROM customer WHERE id = ?`). A suspended or deleted customer still resolves. An erased
  customer resolves to a `null` email, because erasure nulls the column in place
  ([ADR-037](../adr/037-consent-record-and-tombstone-erasure.md)), so that customer's orders send no
  more buyer emails. No row at all also gives no contact.

### The idempotency store

`infrastructure/idempotency/idempotency-store.typeorm.repository.ts`, `IdempotencyStoreTypeormRepository`.
It implements the port directly, not through `BaseTypeormRepository`. The flows are in
[ADR-036](../adr/036-idempotency-key-store-and-enforced-occ.md) and `README.md` §5; what follows is
what the table rows actually hold.

- **A row with a `NULL` `response_body` is a pending reservation.** Only Issue Refund's `reserve`
  writes one. `find` treats a pending row as a miss, and `release` deletes a row only while its
  `response_body` is still `NULL`, so a completed record is never released.
- **`reserve` classifies a key that is already taken, in this order:**
  1. a different fingerprint is `mismatch` (`422`), even while the holder is still pending;
  2. a pending row is `in-progress` (`409`);
  3. a completed row is `replay`.

  If the row disappears between the failed `INSERT` and the re-read (a release or the purge), the
  answer is `in-progress`, so the client retries.

- **`finalize` updates the row by `(scope, key)` and does not check that it is pending.**
- **`save`, used by the find/save flows, swallows a duplicate key.** The first stored response wins,
  and the concurrent loser returns its own result without storing it. A duplicate is recognised by
  MySQL errno `1062` / `ER_DUP_ENTRY` on the error or on its `driverError`.
- **`expires_at` is the Node clock plus `IDEMPOTENCY_KEY_TTL_HOURS` at insert time.** `created_at` is
  the database's `CURRENT_TIMESTAMP`. Neither `find` nor `reserve` looks at `expires_at`: a row keeps
  answering until the purge deletes it.
- **`scope` and `key` are `VARCHAR(64)`.** The gateway's `@IdempotencyKey()` trims the header and
  rejects it only when empty; it does not bound its length.

## Messaging

### Where each event goes

`infrastructure/messaging/order-rabbitmq.publisher.ts`, `OrderRabbitmqPublisher`.

| Primary emit onto     | Events                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `notification_events` | `retail.order.placed`, `retail.fulfillment.shipped`, `retail.fulfillment.delivered`, `retail.refund.issued`             |
| `retail_queue`        | `retail.payment.authorized`, `retail.payment.captured`, `retail.fulfillment.created`, `retail.refund.failed`            |
| both                  | `retail.order.cancelled`: the two emits run concurrently (`Promise.all`), and the `ris.events` mirror is published once |

Every method awaits the broker's acknowledgement of the primary emit, then mirrors onto `ris.events`.
If the primary emit rejects, the method throws before the mirror is published. Every use case catches
a publish failure after its commit and logs it at `warn`; there is no outbox and no retry, so the
event is lost from the queue and from the firehose alike. For `retail.order.cancelled`, one of the
two emits can land while the other fails.

### What `retail_queue` does with an event

- **Retail consumes `retail_queue` with Nest's default `noAck: true`.** The retail `main.ts` sets no
  `noAck`, unlike the notification and event-store services, so the broker counts a message as
  delivered as soon as it hands it over. Nothing on `retail_queue` is ever redelivered.
- **The four reserved events that retail emits onto its own queue are received by retail and
  discarded.** No handler matches, so Nest logs its "no matching event handler" message at `error`
  and the message is gone (`@nestjs/microservices` 11.1.19, `ServerRMQ.handleEvent` falling through
  to `Server.handleEvent`). They survive only as their `ris.events` mirror.
- **`OrderCancelledConsumer` is the only event handler on `retail_queue`.** Given an event with
  `paymentFlaggedForRefund: true` (`infrastructure/consumers/order-cancelled.consumer.ts`):
  1. It reads the payment. If there is none, it logs at `warn` and stops.
  2. If `amountMinor − refundedAmountMinor ≤ 0`, it logs at `info` and stops.
  3. Otherwise it calls `IssueRefundUseCase.execute` once for that remainder. Any throw, including
     `ORDER_IDEMPOTENCY_KEY_IN_PROGRESS` from a concurrent duplicate, is logged at `warn` and
     swallowed.

  Because the queue auto-acknowledges, a duplicate reaches the consumer only if the event is
  published twice. A process that dies inside the handler loses the auto-refund for good (see
  [Failure modes](#failure-modes)).

### Outbound RPCs and the audit seam

- **Allocate, Cancel Allocation and Commit Sale go through `sendPreservingRpcError`, but the two
  catalog calls do not** (`order-catalog.rabbitmq.adapter.ts`). A catalog rejection during Place
  therefore reaches the caller as a bare `Internal server error`, without its code; see
  [`shared-libraries.md`](shared-libraries.md#messaging).
- **`catalog.price.select` is sent without `asOf`**, so the catalog resolves the price as of its own
  current time. `null` means that no price is in effect (`OrderCatalogRabbitmqAdapter.selectApplicablePrice`).
- **`AUDIT_LOG_PUBLISHER` is bound to a mirror-only emit.** `AuditLogRabbitmqPublisher.publish` maps
  the event with `toAuditStaffActionEvent` and hands it to `RisEventsMirrorPublisher.mirror`, which
  never throws (`infrastructure/audit/audit-log.rabbitmq.publisher.ts`). A refund whose audit emit fails
  still succeeds, and has no `audit_log_entry`; the lost event is in the `warn` log, payload
  included.

### The payment gateway binding

`infrastructure/payment-gateway/fake-payment-gateway.adapter.ts`, `FakePaymentGatewayAdapter`, is the
only `PAYMENT_GATEWAY` binding (`orders.module.ts`).

- **It approves every call.**
  - `authorize` returns a random `fake_<uuid>` reference, and the request's `method` or, when that is
    absent, `fake-card`.
  - `capture` echoes the reference it was given.
  - `refund` ignores its request and returns a random `fake_refund_<uuid>` reference.

  Every timestamp it returns is the Node clock at the call. The references must be unique, because
  `payment.gateway_reference` carries a UNIQUE constraint.

- **The decline paths are reachable only by replacing a method on the bound instance**:
  `test/declined-authorization.e2e-spec.ts` does that with a Jest spy. These paths are:
  - the declined-authorization compensation in Place;
  - `ORDER_PAYMENT_NOT_CAPTURED`;
  - `releaseCapture`;
  - a `failed` refund.

## RPC surface

`presentation/orders.controller.ts` serves the twelve `retail.{cart.place,order,payment,fulfillment,refund}.*`
keys listed in `README.md` §2, one use case each, with no logic of its own.

- **The four idempotent handlers return the envelope `{ view, replayed }`**: Place, Capture, Ship and
  Issue Refund. The gateway turns `replayed` into `Idempotent-Replay: true` and, for Place and Issue
  Refund, turns `201` into `200`.
- **`OrderRpcExceptionFilter` catches `OrderDomainException` and nothing else**
  (`presentation/order-rpc-exception.filter.ts`). It is registered with `APP_FILTER`, so it applies
  across the retail app, but it matches only order exceptions. It forwards `details` only when the
  exception has one.
  - Nest turns anything else into a bare `Internal server error`. That covers a plain `Error` from the
    domain or a repository, and a catalog rejection relayed by Place. The gateway shows it as a `500`.
- **A well-formed request that asks for something retail refuses is `422`, not `400`**:
  `PARTIAL_CAPTURE_UNSUPPORTED` (a valid integer that is not the order total) and
  `ORDER_IDEMPOTENCY_KEY_REUSED`. `400` is kept for malformed input. The domain's shape codes answer
  `400` too, as a backstop for a direct RMQ caller that the gateway DTOs did not screen.

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
- **A lost auto-refund.** If the `retail_queue` copy of `retail.order.cancelled` is not published, or
  the process dies inside `OrderCancelledConsumer`, nothing retries: the queue auto-acknowledges and
  the publish failure was only logged. The payment stays `captured` with `flagged_for_refund` set.
  No report lists flagged payments, so the money goes back only through a manual Issue Refund.
- **A refund key stuck in flight.** If the process dies between Issue Refund's `reserve` and its
  `finalize` or `release`, the pending row stays. That key answers `409 ORDER_IDEMPOTENCY_KEY_IN_PROGRESS`
  until the purge deletes the row, which is at least `IDEMPOTENCY_KEY_TTL_HOURS` later. A request
  under a new key is not held back by it.
- **A cart edited during Place.** The cart's lines are read before the place transaction and without
  a lock, and the conversion checks only `status = 'active'`. A line change that commits between the
  read and the conversion is therefore missing from the order, and the order is built from the lines
  as first read.
