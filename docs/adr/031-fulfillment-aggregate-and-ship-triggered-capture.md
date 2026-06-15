# ADR-031: Fulfillment aggregate and ship-triggered capture

- **Date**: 2026-06-15
- **Status**: Accepted

---

## Context

[ADR-028](028-cart-order-payment-and-address-chain.md) rebuilt the retail checkout
as a mutable `Cart` → immutable `Order` chain with **three orthogonal status axes**
(`status` = pending/confirmed/cancelled/shipped/delivered; `paymentStatus` =
none/authorized/captured/refunded/failed; `fulfillmentStatus` =
unfulfilled/partially-shipped/shipped/delivered) and **authorize-on-place,
capture-explicit** payments through a `PAYMENT_GATEWAY` port. It deliberately
shipped **only the payment-axis mutators** (`markPaymentAuthorized` /
`markPaymentCaptured`) and left the lifecycle and fulfillment axes parked at their
place-time defaults — a placed order is `pending` / `unfulfilled` and stays there,
because nothing drives it forward yet.

[ADR-030](030-reservation-ttl-aggregate-and-stock-movement-ledger.md) then built
the inventory-reservation surface: a cart's stock is **reserved** on add, **allocated**
into an order at place-time (`quantityReserved → quantityAllocated`), and a typed,
append-only **`StockMovement`** ledger records every counter change — with one
fixed-sign type left **without a producer**: `sale` (strictly negative). Allocated
stock is *promised* but has not *physically left* the warehouse; nothing decrements
`quantity_on_hand` for an allocated unit.

Two gaps remain between a placed-and-paid order and a delivered one:

- **No shipment record.** There is no way to say "these line quantities went out in
  this box, from this warehouse, on this date, with this tracking number" — and an
  order can ship in **parts** (a partial shipment) or from **several locations** (a
  split shipment), so a single status flag on the order cannot model it.
- **No mechanism takes the money on ship or moves the physical stock.** Capture is
  a separate manual operation; the `sale` movement type has no caller; an
  `authorized` payment can sit captured-or-not while the goods leave.

No production data exists, so this is a clean addition, not a migration of live rows.

This ADR records the **whole fulfillment-and-ship capability** in one decision (the
[ADR-029](029-category-materialized-path-and-polymorphic-media.md) /
[ADR-030](030-reservation-ttl-aggregate-and-stock-movement-ledger.md) precedent —
one ADR decides the capability, the code lands across several sessions). The
foundation (the `Fulfillment` aggregate + tables + repository + the new error codes +
the wire enum/views) ships first; the operations (Create / Ship / Deliver / Cancel),
the cross-service Commit Sale RPC, the gateway endpoints, the notification consumers,
and the e2e suites follow.

## Decision

### A per-shipment `Fulfillment` aggregate, a sibling in the `orders/` module

Add a **`Fulfillment extends AggregateRoot<number | null>`** root and its
**`FulfillmentLine extends Entity<number | null>`** children to the retail
**`orders/`** module — **not** a new bounded context. A fulfillment's operations act
on the `Order` and `Payment` aggregates (ship advances the order's fulfillment axis
and captures its payment), so it belongs in the same bounded context and **reuses
`OrderDomainException` + `OrderErrorCodeEnum`** — the one-throwable-per-module
convention `Payment` and `Address` already follow (ADR-028 §4). A standalone
`fulfillment/` or `payment/` module would only buy cross-module coupling for no
isolation gain.

A `Fulfillment` is **per-shipment and per-`stockLocationId`**: it carries an opaque
inventory `stock_location` id (retail never imports inventory — the id is a
cross-service string, the `reservation`/`movement` opaque-id precedent). Its
`FulfillmentLine` children say **which `OrderLine` quantity** is in this shipment.
Partial and split shipments fall out naturally — an order owns **several**
`Fulfillment` rows, each with its own lines and its own status.

`Fulfillment.status` (`FulfillmentStatusEnum` = pending/shipped/delivered/cancelled)
is a **fourth status axis** beside the order's three orthogonal axes (ADR-028 §2).
It lives *per shipment*; the order's own `fulfillment_status` is the **roll-up across
all of its fulfillments** (`shipped` iff every line is fully shipped, else
`partially-shipped`), computed by the Ship / Deliver operations — not stored on the
fulfillment. A worked state: an order `confirmed` / `captured` / `partially-shipped`
can own one `shipped` `Fulfillment` (the first box) and one `pending` `Fulfillment`
(the rest) at the same time.

The aggregate carries its **own `@VersionColumn`** — the per-shipment
optimistic-concurrency token the cross-cutting "Concurrency & consistency" rule
names. As with `order.version` / `stock_level.version`, it ships now and advances on
every mutation even though the guard that consumes it is a later hardening
(retrofitting OCC onto a populated table is a destructive `ALTER`).

**The aggregate enforces only its own shape**: ≥ 1 line, each line quantity a
positive integer, the legal status transitions, and **tracking-on-ship**. The
**cross-fulfillment invariant** — the per-`OrderLine` sum across all of an order's
shipments ≤ the ordered quantity — is **not** in the model: the aggregate cannot see
sibling fulfillments or the order's line quantities, so the **Create Fulfillment use
case** enforces it (`FULFILLMENT_QUANTITY_EXCEEDS_REMAINING`).

Mutators (each bumps `version`, each rejects an illegal transition with
`FULFILLMENT_INVALID_STATUS_TRANSITION`):

- `ship({ trackingNumber, carrier, shippedAt })` — `pending → shipped`. **Tracking is
  required for `shipped`** (the configurable default policy): a null/blank
  `trackingNumber` raises `FULFILLMENT_TRACKING_REQUIRED`. Stamps `shippedAt`.
- `markDelivered(at)` — `shipped → delivered`, stamps `deliveredAt`.
- `cancel()` — `pending → cancelled`. **A `shipped`/`delivered` fulfillment is never
  cancellable** — that is precisely what protects Cancel Order's precondition (you
  can never strand physically-shipped stock with a cancellation). Cancellation is a
  **status transition, never a row delete** — `fulfillment` is append-only,
  `deleted_at` inert.

### Ship-triggered automatic capture (Q5)

**Ship captures the payment.** When the Ship operation runs, it inspects
`Payment.status`:

- `authorized` → **capture inline, before the local commit**, through the existing
  `PAYMENT_GATEWAY.capture` seam (the `CapturePaymentUseCase` template — the gateway
  call is out-of-process, outside the DB transaction).
- `captured` → an explicit capture already happened; **skip** the gateway call and
  just commit the sale.
- any other state (voided/failed/refunded) → reject `409`.

The compensation choice on a **capture failure** is **block ship until Payment
succeeds**: if the gateway declines the capture, the ship aborts (`409
ORDER_PAYMENT_NOT_CAPTURED`) — no fulfillment transition, no local commit, no Commit
Sale. This is the deliberately **simpler stance** — there is no partial saga and no
`pending-with-payment-failure` intermediate state to model, reconcile, or expose. The
order is left exactly as it was; an operator retries the ship once the payment
problem is resolved.

### The Commit Sale cross-service RPC

Ship physically moves the stock through a new inventory RPC,
**`inventory.stock.commit-sale`**, reached over RabbitMQ through a
**module-prefixed `INVENTORY_COMMIT_SALE_GATEWAY` port** in the retail orders module
— modelled on the retired confirm-flow seam (ADR-013's `INVENTORY_CONFIRM_GATEWAY`,
now gone) and obeying the same isolation rule: the `ClientProxy` is confined to a new
`infrastructure/messaging/*-rabbitmq.adapter.ts`, the use case depends only on the
port (ADR-004/009/020).

Commit Sale, per shipped line, **decrements both `quantity_on_hand` and
`quantity_allocated`** in one `StockLevel.commitSale(quantity)` mutation (one
`version` bump) — the allocated stock is physically leaving, so it is no longer
*promised* (`allocated`) and no longer *present* (`on_hand`). `available = onHand −
allocated − reserved` is unchanged (both decremented counters subtract from it),
which is exactly right: shipping already-promised stock neither frees nor consumes
availability. It writes one strictly-negative **`sale`** `StockMovement` per line
(`referenceType 'fulfillment'`, `referenceId = fulfillmentId`), is **all-lines-atomic**
inside the existing bounded optimistic write protocol (`runWithStockWriteRetry`), and
emits the reserved `inventory.stock.committed` + the per-insert
`inventory.stock-movement.recorded`.

Commit Sale runs **after** the retail local ship commit, and is **idempotent on
`(fulfillmentId)`** via the ledger's `(reference_type, reference_id)` index — so a
transient RMQ failure is retried safely (the cross-cutting consistency rule), and the
local ship is **not** rolled back on an inventory hiccup (eventual consistency on the
decrement; a hard failure is logged for operator replay, which the idempotency makes
safe).

### Cancel Order / Cancel Line

**Cancel Order** (owner **or** staff `order:cancel`) terminates a *pre-fulfillment*
order. Precondition: **no `shipped`/`delivered` Fulfillment** exists
(`FULFILLMENT_REPOSITORY.listByOrderId` → `ORDER_NOT_CANCELLABLE` otherwise);
`pending` fulfillments are cancelled along with it. In one transaction it
`order.cancel()`s, cancels each `pending` fulfillment, and settles the payment:

- `captured` payment → `payment.flagForRefund()` (sets `flagged_for_refund`; the
  refund itself is a **later capability** that consumes the flag, the column ADR-028
  §6 shipped ahead of its writer),
- `authorized` payment → `payment.void()` (`AUTHORIZED → VOIDED`).

After the commit it releases the order's allocation through the **existing**
`inventory.allocation.cancel` (ADR-030's `ORDER_INVENTORY_GATEWAY.cancelAllocation`,
which writes a negative `release` movement and decrements `quantity_allocated`),
best-effort with the same retry/log-replay posture as Commit Sale.

**Cancel Line** (staff `order:cancel`) cancels the **unshipped quantity** of one
`OrderLine` (cancellable = ordered − already-shipped; over-cancel →
`FULFILLMENT_QUANTITY_EXCEEDS_REMAINING`; unknown line → `ORDER_LINE_NOT_FOUND`) and
releases just that quantity's allocation. It does not touch the order's money totals
(credit/refund is the later refund capability).

### Status codes, routing keys, schema, and the cache

`OrderErrorCodeEnum` gains eight codes, all mapped in the filter's total `Record`:
`FULFILLMENT_NOT_FOUND` (404), `FULFILLMENT_NO_LINES` (400),
`FULFILLMENT_LINE_QUANTITY_INVALID` (400), `FULFILLMENT_QUANTITY_EXCEEDS_REMAINING`
(409), `FULFILLMENT_INVALID_STATUS_TRANSITION` (409), `FULFILLMENT_TRACKING_REQUIRED`
(400), `ORDER_NOT_CANCELLABLE` (409), `ORDER_LINE_NOT_FOUND` (404). The Ship operation
adds one more later (`ORDER_INVALID_FULFILLMENT_TRANSITION`, the order's
fulfillment-axis guard).

Five new routing keys (ADR-008 dotted `<service>.<aggregate>.<action>`, value-for-value
in `ROUTING_KEYS` and the mirrored `MicroserviceMessagePatternEnum`) plus the one new
inventory RPC arrive with their producers across the capability:
`inventory.stock.commit-sale` (RPC) + `inventory.stock.committed` (event);
`retail.fulfillment.ship` / `.deliver` (RPC) + `retail.fulfillment.shipped` /
`.delivered` (event); `retail.order.cancel` / `.cancel-line` (RPC) +
`retail.order.cancelled` (event — a key ADR-028 *retired*, **re-introduced fresh**
here with a live producer, not resurrected from a stub).

Schema: two append-only tables. `fulfillment` (BIGINT PK; `order_id` FK → `order.id`
`ON DELETE RESTRICT`; `stock_location_id` a plain VARCHAR scalar with **no FK** —
retail never imports inventory; `status` ENUM; nullable `tracking_number` / `carrier`
/ `shipped_at` / `delivered_at`; a `version` `@VersionColumn`; an `(order_id,
shipped_at)` index; inert `deleted_at`) and `fulfillment_line` (BIGINT PK;
`fulfillment_id` FK → `fulfillment.id` `ON DELETE CASCADE` — a line cannot outlive its
fulfillment; `order_line_id` FK → `order_line.id` `ON DELETE RESTRICT`; `quantity`
INT; an `(order_line_id)` index).

**No inventory cache version bump.** Commit Sale changes the *values* of
`quantity_on_hand` / `quantity_allocated`, not the cached `StockLevel` value *shape*,
so the `INVENTORY_STOCK_KEY_VERSION` stays `v3`; freshness still routes through the
ADR-023 post-commit `withInvalidation`.

## Alternatives Considered

- **One combined order-status enum** (a single `status` collapsing lifecycle,
  payment, and fulfillment). Rejected by ADR-028 §2 and re-rejected here: a `shipped`
  fulfillment must coexist with a `captured` payment and a `confirmed` lifecycle, and
  a partial shipment must coexist with `unfulfilled` siblings — a single enum forces
  illegal intermediate states. The fourth, per-shipment `Fulfillment.status` is the
  natural extension of the orthogonal-axes decision, not a new combined value.

- **A standalone `fulfillment/` (or `payment/`) bounded-context module.** Rejected:
  every fulfillment operation acts on `Order` + `Payment`, so a separate module would
  re-import the orders context across a boundary (the very coupling the
  one-throwable-per-module convention and ADR-028 §4 avoid for `Payment`). The
  sibling-aggregate placement keeps the bounded context whole.

- **A full saga / order-state rollback on capture failure** (a
  `pending-with-payment-failure` state, compensating actions, a reconciliation
  worker). Rejected for **block-ship-until-payment-succeeds**: capture runs before the
  local commit, so a decline simply aborts the ship with nothing written — no partial
  state to compensate, no extra status value to expose. The simpler stance is correct
  for a single-capture-per-ship flow; a saga would be premature machinery.

- **Decrementing only `quantity_on_hand` on Commit Sale** (leaving
  `quantity_allocated` as-is). Rejected: `available = onHand − allocated − reserved`,
  so an allocated unit that ships but never clears from `allocated` would
  **permanently understate `available`** — the warehouse would look fuller of
  obligations than it is, forever. Both counters must drop together; the running
  totals stay the balance authority (ADR-027), the `sale` ledger row is the audit
  trail.

- **A hard publish-style block on Commit Sale failure** (roll the local ship back if
  the inventory RPC fails). Rejected: the ship has already taken the money and the
  box has physically left; rolling back the retail record because an asynchronous
  inventory decrement hiccuped is worse than an eventually-consistent retry. Commit
  Sale's `fulfillmentId` idempotency makes the retry/replay safe.

## Consequences

- The retail `orders/` module gains a fourth aggregate (`Fulfillment` + its
  `FulfillmentLine` children) alongside `Order` / `Payment` / `Address`, sharing the
  one `OrderDomainException`, the one `TRANSACTION_PORT`, and the orders message
  surface. The bounded context stays whole.
- Partial and split shipments are first-class: an order resolves to a list of
  `Fulfillment`s, each per-location and independently status-tracked, and the order's
  own `fulfillment_status` becomes a derived roll-up.
- Shipping is the single operation that **advances three axes and crosses the service
  boundary**: it captures payment (payment axis), advances the order's fulfillment
  axis + each line's status, and physically decrements inventory via Commit Sale. The
  capture-before-commit / commit-sale-after-commit ordering plus `fulfillmentId`
  idempotency make it safe to retry.
- The `sale` `StockMovement` type (dormant since ADR-030) gets its producer; every
  counter-changing inventory operation continues to leave an audit row.
- Cancellation is modelled as **append-only state transitions** with an allocation
  release, never a delete; the `flagged_for_refund` column ADR-028 shipped finally
  gets its writer, while the refund itself stays a named future capability.
- `order.version` and `fulfillment.version` are both live OCC tokens that advance on
  every mutation; the guard that consumes them remains a later concurrency-hardening
  step.

## References

- [ADR-028](028-cart-order-payment-and-address-chain.md) — the Cart/Order/Payment/Address
  chain, the three orthogonal order axes (Q4), authorize-on-place + capture-explicit,
  the `PAYMENT_GATEWAY` port, and the one-throwable-per-module convention this ADR
  extends.
- [ADR-030](030-reservation-ttl-aggregate-and-stock-movement-ledger.md) — the
  reservation/allocation surface, the typed `StockMovement` ledger (the `sale` type
  this capability finally produces), the bounded optimistic write protocol Commit Sale
  reuses, and the `inventory.allocation.cancel` Cancel Order rides.
- [ADR-027](027-stocklevel-running-totals-and-stocklocation.md) — `StockLevel` running
  totals are the balance authority; the ledger is the audit trail; the cache value
  shape Commit Sale does not change.
- [ADR-013](013-order-aggregate-and-cross-service-confirm.md) (superseded) — the
  retired `INVENTORY_CONFIRM_GATEWAY` cross-service seam Commit Sale's gateway is
  modelled on.
- [ADR-008](008-rabbitmq-via-libs-messaging.md) — the dotted routing-key format and
  lock-step `MicroserviceMessagePatternEnum` agreement the five new keys + the RPC
  follow.
