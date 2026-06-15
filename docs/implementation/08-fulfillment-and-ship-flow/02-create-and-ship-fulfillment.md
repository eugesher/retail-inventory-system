# Create and ship a fulfillment

This document describes the operations that act on the `Fulfillment` aggregate
introduced in
[01-fulfillment-aggregate-and-three-statuses.md](01-fulfillment-aggregate-and-three-statuses.md):
planning a shipment (**Create Fulfillment**), reading an order's shipments (**List
Fulfillments**), and — documented by the ship operation in a later section —
**Ship Fulfillment**. All of them live in the retail `orders/` module, served by the
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

## 4. Ship Fulfillment + tracking-number policy

> The **Ship Fulfillment** operation — which captures the order's payment, physically
> decrements inventory through the cross-service Commit Sale RPC, advances the order's
> fulfillment axis and each shipped line's status, and enforces the
> tracking-number-required policy — is documented in this same file by the ship
> operation. The `Fulfillment.ship` mutator and its tracking-on-ship rule already exist
> on the aggregate (see
> [01-fulfillment-aggregate-and-three-statuses.md](01-fulfillment-aggregate-and-three-statuses.md));
> the operation that drives it is added here when it lands.
