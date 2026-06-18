# Create and ship a fulfillment

This document describes the operations that act on the `Fulfillment` aggregate
introduced in
[01-fulfillment-aggregate-and-three-statuses.md](01-fulfillment-aggregate-and-three-statuses.md):
planning a shipment (**Create Fulfillment**), reading an order's shipments (**List
Fulfillments**), and shipping one (**Ship Fulfillment**, §4). All of them live in the
retail `orders/` module, served by the
orders RPC controller, because a fulfillment is a sibling aggregate of `Order` /
`Payment` / `Address` (see
[ADR-031](../../adr/031-fulfillment-aggregate-and-ship-triggered-capture.md)).

## 1. Create Fulfillment

**Create Fulfillment plans a shipment.** It opens a `pending` `Fulfillment` against a
placed order, naming the location it ships from and the per-`OrderLine` quantities it
carries. It does **not** move stock or take money — that is the separate Ship
operation. Create is the planning step; an order can be planned into **several**
fulfillments (partial and split shipments, §2).

RPC: `retail.fulfillment.create` → `CreateFulfillmentUseCase` →
[`FulfillmentView`](../../../libs/contracts/retail/dto/fulfillment.view.ts). The
imperative `create` command is distinct from the past-tense `retail.fulfillment.created`
event the operation emits after persisting — the same imperative-vs-event split as
`catalog.variant.create` / `.created` ([ADR-008](../../adr/008-rabbitmq-via-libs-messaging.md)).

### Owner-or-staff authorization

Create is authorized **owner-or-staff**, the single authorization model the whole
orders module uses ([ADR-028](../../adr/028-cart-order-payment-and-address-chain.md) §7,
[ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)). The use case
calls the shared `loadAuthorizedOrder(orderRepository, orderId, actorId, staffOverride)`
helper: the caller is allowed if the gateway confirmed it carries the staff
`order:fulfill` permission (`isStaffFulfill = true`), **or** if it owns the order
(`order.customerId === actorId`). A non-owner non-staff caller is `403`
(`ORDER_ACCESS_FORBIDDEN`); a missing order is `404` (`ORDER_NOT_FOUND`).

A permission code is always a **staff override layered over the owner-check, never a
customer gate** — a customer carries no permissions, so it can only ever reach its own
order. In practice Create is staff-run from the warehouse, but the owner-or-staff shape
keeps the module's one authorization model intact rather than inventing a staff-only
path.

### Preconditions: the order must be fulfillable

Two order-level preconditions are checked before any fulfillment is built, both
rejecting with `ORDER_NOT_FULFILLABLE` (`409`):

- **Lifecycle.** `order.status ∈ {pending, confirmed}`. A `cancelled` / `shipped` /
  `delivered` order cannot accept a new shipment.
- **Payment.** `order.paymentStatus ∈ {authorized, captured}`. An order with nothing
  authorized cannot be fulfilled — there is no money committed to pay for the goods
  about to leave. The payment progress lives on the `Order` header (the payment axis),
  so this check needs no separate `Payment` load.

`ORDER_NOT_FULFILLABLE` is an order-state precondition, deliberately **distinct** from
`FULFILLMENT_INVALID_STATUS_TRANSITION` (which is about a `Fulfillment`'s own
`pending → shipped → delivered` mutators being called from the wrong state). At Create
time no fulfillment exists yet, so the rejection is about the *order's* state, not a
shipment's — a separate code reads honestly and is independently greppable.

### The cross-fulfillment quantity invariant

This is the heart of the use case. The `Fulfillment` aggregate enforces only **its own
shape** — at least one line, each line's quantity a positive integer — because it
cannot see its sibling fulfillments or the order's ordered quantities (an aggregate
must never reach across to another aggregate's state). The rule that ties a shipment to
the order it ships from therefore lives in the **Create use case**, which loads both:

For each requested `{ orderLineId, quantity }`:

1. **The line must belong to the order.** If `orderLineId` is not one of the order's
   lines, reject `ORDER_LINE_NOT_FOUND` (`404`).
2. **The requested quantity must fit the remaining unshipped count.** Compute the
   **already-fulfilled** quantity for that order line = the sum of its
   `FulfillmentLine.quantity` across all of the order's **non-`cancelled`**
   fulfillments (loaded via `FULFILLMENT_REPOSITORY.listByOrderId`). The request is
   valid only when `alreadyFulfilled + requested ≤ ordered`; otherwise reject
   `FULFILLMENT_QUANTITY_EXCEEDS_REMAINING` (`409`), with the remaining count carried in
   the message.

A **cancelled** fulfillment is excluded from the already-fulfilled sum, so cancelling a
planned shipment frees its quantities back to the remaining pool — the units never
left, so they are available to re-plan.

The aggregate's own shape guards (`FULFILLMENT_NO_LINES` for an empty request,
`FULFILLMENT_LINE_QUANTITY_INVALID` for a non-positive quantity) are left to
`Fulfillment.create`, which runs after the cross-fulfillment checks. This keeps the
aggregate the single authority on its own invariants and the use case the single
authority on the cross-aggregate one.

### Default location

`stockLocationId` is optional on the request. When omitted it defaults to
`default-warehouse` (the `INVENTORY_DEFAULT_STOCK_LOCATION` constant in
`libs/contracts/inventory`). Multi-location *sourcing* — automatically splitting one
request across warehouses by where the stock physically sits — is out of scope; a
caller that wants a split plans one Create per location explicitly (§2).

### Side-effect-free on the order header

Create yields a `pending` `Fulfillment` and **leaves the order and its line statuses
untouched**. A line only becomes `partially-shipped` once its units are physically *in
flight*, which is the Ship operation's job — so flipping a line status at plan time
would be premature. Keeping Create a single repository write (the fulfillment root + its
lines + a re-read, one transaction) with no order-header churn keeps the operation
simple and the order's status axes driven by exactly one operation each.

After the write commits, the use case emits `retail.fulfillment.created` best-effort
onto `retail_queue` (built from the saved aggregate's concrete ids). The emit is
post-commit and warn-and-swallow ([ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)):
a publish failure never fails a committed plan. The event is a reserved surface — no
consumer is bound yet.

## 2. Partial vs full ship (setup)

Because a `Fulfillment` is **per-shipment and per-location**, an order resolves to a
**list** of fulfillments rather than a single shipment flag — and partial and split
shipments fall out for free:

- A **full shipment** plans one `Fulfillment` carrying every line's full ordered
  quantity.
- A **partial shipment** plans a `Fulfillment` carrying *fewer* units of a line than
  were ordered; the remainder is planned later in a second `Fulfillment`. Each
  fulfillment line carries its own slice of the ordered quantity.
- A **split shipment** plans different lines (or different units of the same line) from
  different warehouses — each warehouse's box is its own `Fulfillment` with its own
  `stockLocationId`.

The invariant that holds these together is the per-`OrderLine` sum: **across all of an
order's non-`cancelled` fulfillments, the sum of a line's fulfilled quantities never
exceeds the ordered quantity.** Create enforces it incrementally — each new shipment is
measured against the already-fulfilled remainder (§1). A worked sequence for a line
ordered at quantity 3:

| Step | Request | Already fulfilled | Remaining | Outcome |
| --- | --- | --- | --- | --- |
| 1 | ship 2 | 0 | 3 | accepted (a `pending` fulfillment of 2) |
| 2 | ship 2 | 2 | 1 | rejected `FULFILLMENT_QUANTITY_EXCEEDS_REMAINING` |
| 3 | ship 1 | 2 | 1 | accepted (the line is now fully planned) |

The order's own roll-up `fulfillmentStatus` (`unfulfilled` →
`partially-shipped` → `shipped`) is **not** stored on the fulfillment; it is derived by
the Ship operation across the order's shipments once units are in flight.

## 3. List Fulfillments

RPC: `retail.fulfillment.list` → `ListFulfillmentsUseCase` → `FulfillmentView[]`. It
returns every `Fulfillment` for one order, **newest-first** (`shipped_at DESC, id DESC`
via `FULFILLMENT_REPOSITORY.listByOrderId`). An order with no fulfillments resolves to
an empty array (a `200`, not a `404`).

Authorization is **owner-or-staff `order:read`** — the read-path analogue of Create's
gate. The use case calls `loadAuthorizedOrder(..., canReadAny)`: the owner sees its own
order's shipments, and staff carrying `order:read` (folded into `canReadAny` at the
gateway) can read any. The order is loaded purely to gate the read — the authorization
rule lives on the order, and the fulfillments hang off it.

## 4. Ship Fulfillment

**Ship Fulfillment is the operation that physically moves the stock and takes the
money.** It is the single operation that advances three status axes at once and crosses
the service boundary: it captures the order's payment (the payment axis), advances the
order's fulfillment axis and each shipped line's status, and physically decrements
inventory through the cross-service Commit Sale RPC.

RPC: `retail.fulfillment.ship` → `ShipFulfillmentUseCase` → `FulfillmentView` (the
updated shipment; the order's advanced statuses are observable via a follow-up
`retail.order.get`). The imperative `ship` command is paired with the past-tense
`retail.fulfillment.shipped` event the operation emits after committing.

The **payment-capture half** of Ship — when it captures, what happens if the capture
fails, and what happens if the inventory decrement fails after the commit — is its own
topic, documented in
[03-ship-triggered-capture-q5.md](03-ship-triggered-capture-q5.md). This section covers
the fulfillment mechanics: authorization, preconditions, the tracking-number policy, and
the partial-vs-full status roll-up.

### Owner-or-staff authorization

Ship is authorized **owner-or-staff `order:fulfill`**, the same gate as Create (§1) via
`loadAuthorizedOrder(orderRepository, orderId, actorId, isStaffFulfill)`. Practically
Ship is staff-run from the warehouse, but the owner-or-staff shape keeps the module's one
authorization model.

### Preconditions

- **The fulfillment exists and belongs to the order.** `FULFILLMENT_REPOSITORY.findById`
  resolves the shipment; a missing one, or one whose `orderId` does not match the
  request, is `404` (`FULFILLMENT_NOT_FOUND`).
- **The fulfillment is `pending`.** Only a planned-but-unshipped shipment can ship; a
  `shipped` / `delivered` / `cancelled` one is `409`
  (`FULFILLMENT_INVALID_STATUS_TRANSITION`). A repeated ship of the same fulfillment is
  therefore rejected rather than silently re-run — the `Idempotency-Key` header is
  accepted and logged but **not** deduped, and Commit Sale is independently idempotent on
  `fulfillmentId` inventory-side, so a genuine retry never double-decrements stock.
- **A tracking number is supplied** (the tracking-number policy, below).
- **The order has a payment to capture.** A fulfillable order was authorized-on-place, so
  a missing payment is an invariant breach (`409`).

### The tracking-number policy

**A tracking number is required to mark a shipment `shipped`** — the configurable default
policy. A null or blank `trackingNumber` is rejected `FULFILLMENT_TRACKING_REQUIRED`
(`400`). The rule has two enforcement points working together:

- The **domain** `Fulfillment.ship({ trackingNumber, carrier, shippedAt })` mutator is
  the authority — it refuses to leave `pending` without a non-blank tracking number (see
  [01-fulfillment-aggregate-and-three-statuses.md](01-fulfillment-aggregate-and-three-statuses.md)).
- The **use case** re-checks the same rule up front, *before* the out-of-process payment
  capture. This ordering is deliberate: the capture is an irreversible side effect, so a
  ship that would fail its own tracking precondition must fail **before** any money
  moves, never after. (The same up-front-validation principle is why the capture decision
  runs before the local transaction — see
  [03-ship-triggered-capture-q5.md](03-ship-triggered-capture-q5.md).)

`carrier` is optional shipment metadata that may stay null; only `trackingNumber` gates
the transition. The policy is "configurable" in the sense that the requirement lives in
one place (the domain mutator) and a future relaxation — e.g. allowing a tracking-less
ship for a store pickup — changes exactly that guard.

### Partial vs full ship: the status roll-up

When a fulfillment ships, the operation advances **three** things, all derived from one
source of truth — **the order's fulfillments' shipped line quantities**, not a stored
flag:

1. **Each shipped `OrderLine.status`.** For every order line, the use case sums the units
   shipped across the order's `shipped`/`delivered` fulfillments (the just-shipped one is
   now `shipped` and counted). A line whose cumulative shipped quantity reaches its
   ordered quantity flips to `shipped`; a line with *some but not all* units shipped flips
   to `partially-shipped`; a line with no shipped units stays `allocated`. The flip rides
   `OrderLine.markFulfillment`, a forward-only mutator (`allocated → partially-shipped →
   shipped`) — the only mutable field on the otherwise-immutable place-time line snapshot.
2. **The order's roll-up `fulfillmentStatus`.** `Order.advanceFulfillment(next)` sets the
   header axis to `shipped` **iff every** order line is now fully shipped, else
   `partially-shipped`. The mutator guards the forward chain (`unfulfilled →
   partially-shipped → shipped → delivered`) and rejects a strictly-backward move
   (`ORDER_INVALID_FULFILLMENT_TRANSITION`, `409`); a single full ship legitimately skips
   straight from `unfulfilled` to `shipped`. It touches **only** the fulfillment axis —
   the lifecycle and payment axes are orthogonal (ADR-028 §2).
3. **The `Fulfillment` itself** → `shipped`, stamped with `shippedAt` and the tracking
   metadata.

Why only `shipped`/`delivered` fulfillments count toward the roll-up — and not the
already-fulfilled-including-`pending` sum that **Create** measures (§1) — is the crucial
distinction: Create counts planned units to stop *over-planning* a line, but the roll-up
status must reflect what has *physically shipped*. Counting a `pending` sibling would mark
a line `shipped` before its second box ever left.

A worked sequence for a single-line order, line ordered at quantity 10, planned as two
fulfillments F1 (qty 4) and F2 (qty 6):

| Step | Action | Line shipped | Line status | Order `fulfillmentStatus` |
| --- | --- | --- | --- | --- |
| 1 | ship F1 | 4 / 10 | `partially-shipped` | `partially-shipped` |
| 2 | ship F2 | 10 / 10 | `shipped` | `shipped` |

All of step 1–3's writes — the fulfillment transition, the payment capture record (when
one happened), the line flips, and the order-axis advance — commit in **one local
transaction**. The cross-service Commit Sale and the event emits run **after** that commit
(see [03-ship-triggered-capture-q5.md](03-ship-triggered-capture-q5.md)).
