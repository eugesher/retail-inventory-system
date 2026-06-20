# ADR-032: Returns and refunds — the RMA lifecycle and restock

- **Date**: 2026-06-19
- **Status**: Accepted

---

## Context

[ADR-028](028-cart-order-payment-and-address-chain.md) rebuilt the retail checkout as a
mutable `Cart` → immutable `Order` chain with a `Payment` aggregate (authorize-on-place,
capture-explicit) and three orthogonal order status axes.
[ADR-031](031-fulfillment-aggregate-and-ship-triggered-capture.md) then added the
`Fulfillment` aggregate and ship-triggered capture, taking an order all the way to
`delivered` and physically decrementing inventory through `inventory.stock.commit-sale`.

What the system still cannot do is take goods **back**. There is:

- no record of a buyer asking to return an order's goods, no lifecycle for authorizing
  / receiving / inspecting / settling that request;
- no `Refund` — `Payment` carries a `flagged_for_refund` flag (written by Cancel Order,
  ADR-031) and a `refunded_amount_minor` counter, both **shipped ahead of any writer**,
  with nothing to consume them;
- no way to put a restocked unit back into sellable inventory — the `StockMovement`
  ledger declares a `return` type (ADR-030 §2) that has **no producer**, the mirror of
  the `sale` type that ADR-031 finally gave a producer.

No production data exists, so this is a clean addition, not a migration of live rows.

This ADR records the **whole returns-and-refunds capability** in one decision (the
[ADR-029](029-category-materialized-path-and-polymorphic-media.md) /
[ADR-030](030-reservation-ttl-aggregate-and-stock-movement-ledger.md) /
[ADR-031](031-fulfillment-aggregate-and-ship-triggered-capture.md) precedent — one ADR
decides the capability, the code lands across several sessions). The foundation (the
`ReturnRequest` aggregate + its tables + repository + the wire enums/views + the error
codes) ships first; the operations (Open / Authorize / Reject / Receive / Inspect /
Close), the `Refund` aggregate, Restock from Return, Issue Refund, the auto-refund
consumer, the gateway endpoints, the notification consumers, and the e2e suites follow.

## Decision

### Module placement — three homes, one per concern

The capability is split across three modules, each chosen by **what its operations
mutate**:

- **`ReturnRequest` / `ReturnLine` get their own new retail bounded context**,
  `apps/retail-microservice/src/modules/returns/`. The RMA lifecycle is a substantial
  **six-state machine** with **warehouse-facing operations** (Receive, Inspect) that are
  distinct from order placement; giving it its own module stops the `orders/` module —
  already home to four aggregates — from ballooning. The context gets its own concrete
  throwable, `ReturnDomainException` (with `ReturnErrorCodeEnum`), the
  one-class-per-module convention.

- **`Refund` is a sibling aggregate inside the existing `orders/` module**, reusing
  `OrderDomainException` — **not** a member of the returns context. A refund's operations
  **mutate `Payment`** (they walk its status and increment `refunded_amount_minor`), and
  `Payment` lives in `orders/`; placing `Refund` anywhere else would re-import the orders
  context across a boundary (the very coupling ADR-028 §4 avoids for `Payment`).

- **Restock from Return is an inventory `stock/` operation.** Putting a unit back into
  sellable stock is inventory's job; it rides the existing `StockLevel` running totals
  and the `StockMovement` ledger.

The returns domain must never import the orders module (the per-module isolation rule),
so the reads it needs from `order` / `order_line` at Open time (the returnable-quantity
and return-window checks) go through a **raw-SQL reader port** declared with the Open use
case — the `ORDER_CART_READER` precedent (the orders module reads the cart tables the
same way).

### The six-state RMA lifecycle

`ReturnRequest.status` (`ReturnStatusEnum`, a wire contract on the `return_request.status`
ENUM column) walks:

```
requested → authorized → received → inspected → closed
requested → rejected
```

`rejected` and `closed` are terminal. Each mutator walks exactly one legal transition,
bumps the per-RMA `version`, and rejects an illegal start with
`RETURN_INVALID_STATUS_TRANSITION` (409). The actor/permission per transition:

| Transition               | Actor / permission                   |
| ------------------------ | ------------------------------------ |
| Open (→ `requested`)     | owner **or** staff                   |
| `→ authorized`           | staff `order:return-authorize`       |
| `→ rejected`             | staff `order:return-authorize`       |
| `→ received`             | warehouse `inventory:receive-return` |
| `→ inspected`            | warehouse `inventory:receive-return` |
| `→ closed`               | staff `order:return-authorize`       |

The reads are owner-or-staff (the buyer who owns the order, or staff). The two
permission codes `order:return-authorize` and `inventory:receive-return` were seeded and
bound ahead of their readers; the lifecycle operations are their first consumers.

**The aggregate enforces only its own shape** — ≥ 1 line, each line quantity a positive
integer, and the legal transitions. The cross-line **returnable-quantity invariant**
(Σ requested ≤ ordered − cancelled − already-returned) is **not** in the model: the
aggregate cannot see the order's line quantities or sibling RMAs, so the **Open use
case** enforces it (`RETURN_QUANTITY_EXCEEDS_RETURNABLE`). The aggregate records **no
domain events** — `retail.return.requested` is built and emitted by the Open use case
after persistence assigns the ids and the `RMA-<year>-<pad8(id)>` number (the
`Order.place` / [ADR-011](011-notifier-port-and-adapters.md) precedent). Rejection and
closure are status transitions, never deletes — `return_request` is append-only,
`deleted_at` inert.

### `Refund` as a distinct entity

A `Refund` is **not** folded into `ReturnRequest`. A refund must be able to exist
**without** a return: a chargeback, a goodwill credit, a partial price adjustment, or a
refund issued by Cancel Order on an order that never shipped all have no RMA behind them.
Modeling the refund as a field on `ReturnRequest` would make every one of those
impossible. So `Refund` is its own aggregate (a sibling of `Payment` in `orders/`), and a
return that closes with money owed *triggers* a refund rather than *being* one.

The refund mechanics:

- `Payment.refunded_amount_minor` (the cumulative-refund counter ADR-028 §6 shipped) is
  the source of truth for **how much** has already been refunded. The
  **partial-vs-full** decision reads it against `amount_minor`: a refund that brings the
  cumulative total to `amount_minor` is a full refund (and walks the payment to
  `refunded`), one that leaves a remainder is partial.
- The default `FakePaymentGatewayAdapter` gains a `refund()` that **always succeeds**
  with a deterministic reference — the always-approve posture its `authorize` / `capture`
  already take, so the refund flow is exercisable end-to-end without a real gateway.

### Restock from Return

When Inspect records a `restock` disposition for a line, the goods go back into sellable
inventory through a new cross-service RPC, **`inventory.stock.restock-from-return`**,
reached over RabbitMQ through a module-prefixed `INVENTORY_RESTOCK_GATEWAY` port in the
returns context (the `ORDER_INVENTORY_GATEWAY` / `INVENTORY_COMMIT_SALE_GATEWAY`
precedent; the `ClientProxy` confined to `infrastructure/messaging/`). Restock:

- **increments `quantity_on_hand`** for the variant at its location (the running totals
  stay the balance authority, ADR-027);
- writes one **positive `return`-type `StockMovement`** — the enum member's **first
  producer** (the mirror of ADR-031 giving the `sale` type its producer);
- is **idempotent on `returnRequestId`** via the ledger's `(reference_type,
  reference_id)` index, so a retried restock decrements nothing twice (the
  `commit-sale`/`fulfillmentId` idempotency precedent).

Only `restock` dispositions trigger it; `scrap` and `quarantine` take the goods out of
sellable inventory and write no stock movement.

### Auto-refund from Cancel Order

Cancel Order already settles a captured payment by setting `flagged_for_refund` (ADR-031,
which shipped the *writer* of the flag but left the *reader* a named future capability).
This capability is that reader: retail **consumes its own `retail.order.cancelled`
event** (which carries `paymentFlaggedForRefund`), and when the flag is set it issues a
refund inline through the same Issue Refund path the manual flow uses. So both the manual
(staff-initiated, on a closed RMA) and the automatic (cancel-driven) refund paths run
through one use case, and both are audited.

### Eventing

New dotted routing keys (ADR-008 `<service>.<aggregate>.<action>`, value-for-value in
`ROUTING_KEYS` and the mirrored `MicroserviceMessagePatternEnum`), arriving with their
producers across the capability:

- `retail.return.requested` / `.authorized` / `.rejected` / `.received` / `.inspected` /
  `.closed` — the RMA lifecycle events (notification consumes the buyer-facing ones);
- `retail.refund.issued` — the refund event;
- `inventory.stock.restock-from-return` (the RPC) + `inventory.stock.returned` (the
  event).

**No inventory cache version bump.** Restock changes the *value* of `quantity_on_hand`,
not the cached `StockLevel` value *shape*, so `INVENTORY_STOCK_KEY_VERSION` stays `v3`;
freshness routes through the [ADR-023](023-cache-invalidate-post-commit-by-type.md)
post-commit `withInvalidation`.

### Audit

Refund operations are **always audited** — the cross-cutting "money movements are
audited" rule. The audit record is written retail-side inside Issue Refund, so it covers
**both** the manual and the auto-refund-from-cancel paths through the one use case
(rather than at a gateway endpoint that the cancel-driven path would bypass).

### Idempotency

The `Idempotency-Key` header is **accepted but not deduped** — a persisted idempotency
store remains a later capability (the ADR-028 §6 posture). Refund leans instead on the
**gateway-reference natural idempotency** plus the `refunded_amount_minor` counter: a
re-issued refund that would push the cumulative total past `amount_minor` is rejected, so
a replay cannot over-refund. Restock leans on its `returnRequestId` ledger idempotency.

### Schema

Two append-only tables in the returns context. `return_request` (BIGINT PK; `rma_number`
VARCHAR(20) UNIQUE nullable-until-finalized; `order_id` FK → `order(id)` and
`customer_id` CHAR(36) FK → `customer(id)`, both `ON DELETE RESTRICT`; `status` /
`reason_category` ENUMs; nullable `notes` / `authorized_at` / `closed_at`; a `version`
`@VersionColumn`; `(order_id, requested_at DESC)` and `(customer_id, requested_at DESC)`
indexes; inert `deleted_at`) and `return_line` (BIGINT PK; `return_request_id` FK →
`return_request(id)` `ON DELETE CASCADE` — a line cannot outlive its request;
`order_line_id` FK → `order_line(id)` `ON DELETE RESTRICT`; `quantity` INT; nullable
`condition` / `disposition` ENUMs + `line_refund_amount_minor` BIGINT recorded at
inspection; an `(order_line_id)` index). The `customer_id` FK is `CHAR(36)` (the auth
`customer` UUID PK, mirroring `order.customer_id`) and the table is `utf8mb4_unicode_ci`
so the string-FK collations match. The `rma_number` derives from the generated id (the
`order_number` "finalize a derived field" idiom — no sequence table). The `Refund` table
lands in `orders/` with that aggregate; no new `payment` migration is needed (its two
forward-shipped columns already exist).

## Alternatives Considered

- **`ReturnRequest` as a sibling aggregate in `orders/`** (the `Fulfillment` placement).
  Rejected: the RMA's six-state lifecycle with warehouse-facing Receive/Inspect
  operations is large and self-contained enough that folding it into `orders/` would
  bloat a module already carrying `Order` / `Payment` / `Address` / `Fulfillment`. The
  isolation a separate bounded context buys is worth the new module here, where it was
  not for `Fulfillment` (whose every operation acts on `Order` + `Payment`).

- **`Refund` folded into `ReturnRequest`** (a refund field/amount on the RMA). Rejected:
  a refund must exist for **chargebacks, goodwill credits, partial price adjustments, and
  refund-without-return** (Cancel Order on an unshipped order) — none of which has an RMA.
  A refund is its own entity that a return *triggers*, not one a return *contains*.

- **Reconstructing on-hand from a restock ledger sum.** Rejected by ADR-027 and
  re-rejected here: the `StockMovement` `return` row is an **audit trail**, not the
  balance authority. Restock increments the `quantity_on_hand` running total and writes
  the ledger row as a record of *why*; the balance is never re-derived by summing
  movements.

- **A separate returns microservice.** Rejected ([ADR-018](018-nestjs-monorepo-apps-and-libs.md)):
  there is no independent deploy cadence for returns, and a refund's operations act on
  the retail `Payment` aggregate — a separate service would put a synchronous,
  tightly-coupled call across a network boundary for no isolation gain. A bounded context
  *module* inside the retail service is the right grain.

## Consequences

- The retail service gains a **fifth aggregate home** — the `returns/` bounded context —
  alongside `cart/` and `orders/`. It owns the `ReturnRequest` / `ReturnLine` RMA
  aggregate and its own `ReturnDomainException`.
- `Refund` joins `Payment` / `Address` / `Fulfillment` as a sibling aggregate in
  `orders/`; the `flagged_for_refund` flag and the `refunded_amount_minor` counter that
  ADR-028 / ADR-031 shipped ahead of their writers finally get their reader.
- The `StockMovement` `return` type (dormant since ADR-030) gets its producer, so **every
  counter-changing inventory operation now leaves an audit row** — receipts, adjustments,
  transfers, allocations, sales, releases, and now returns.
- Cancel Order's `paymentFlaggedForRefund` becomes a live signal: retail consuming its own
  cancellation event closes the loop between cancellation and refund without a manual
  step.
- The two RBAC codes seeded for this capability (`order:return-authorize`,
  `inventory:receive-return`) gain their first endpoints; `order:refund` gates Issue
  Refund.
- The capability lands across several sessions: this ADR is the durable decision record;
  the foundation (the `ReturnRequest` aggregate + tables + repository + wire
  enums/views + error codes) ships first, the operations and the refund/restock halves
  follow.

## References

- [ADR-028](028-cart-order-payment-and-address-chain.md) — the Cart/Order/Payment/Address
  chain, the one-throwable-per-module convention, the `version`-ships-now and
  `order_number` "finalize a derived field" idioms, and the `refunded_amount_minor` /
  `flagged_for_refund` columns shipped ahead of their writers.
- [ADR-031](031-fulfillment-aggregate-and-ship-triggered-capture.md) — the `Fulfillment`
  sibling-aggregate placement this ADR contrasts against, the `sale` `StockMovement`
  producer the `return` type mirrors, the `commit-sale`/`fulfillmentId` idempotency the
  restock idempotency follows, and the Cancel Order writer of `flagged_for_refund` this
  capability reads.
- [ADR-030](030-reservation-ttl-aggregate-and-stock-movement-ledger.md) — the typed
  `StockMovement` ledger (the `return` type this capability produces) and the bounded
  optimistic write protocol Restock reuses.
- [ADR-027](027-stocklevel-running-totals-and-stocklocation.md) — `StockLevel` running
  totals are the balance authority; the ledger is the audit trail; the cache value shape
  Restock does not change.
- [ADR-024](024-rbac-v2-staffuser-customer-and-permissions.md) — the relational permission
  model the `order:return-authorize` / `inventory:receive-return` / `order:refund` gates
  use.
- [ADR-018](018-nestjs-monorepo-apps-and-libs.md) — the apps-plus-libs structure under
  which a new bounded context is a module, not a new deployable service.
