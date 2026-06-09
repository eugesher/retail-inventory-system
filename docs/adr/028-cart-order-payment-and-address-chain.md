# ADR-028: Cart, Order, Payment, and Address — the rebuilt checkout chain

- **Date**: 2026-06-10
- **Status**: Accepted (supersedes [ADR-013](013-order-aggregate-and-cross-service-confirm.md))

---

## Context

The first retail order model ([ADR-013](013-order-aggregate-and-cross-service-confirm.md))
shaped a single `Order` aggregate that expanded each ordered line into one
`order_product` row per unit, carried a two-value status
(`pending`/`confirmed`) on both the header and each line, and reserved stock
through a synchronous cross-service `inventory.order.confirm` RPC. That model
predated the catalog/pricing/inventory rebuilds: it keyed lines on a bare
`product_id`, had no money representation, no cart, no payment, and no shipping
or billing address. Stock reservation moved out of the confirm RPC entirely
when inventory re-founded on `StockLevel` running totals ([ADR-027](027-stocklevel-running-totals-and-stocklocation.md)),
leaving `inventory.order.confirm` a deprecation stub.

We now need a checkout capability that a real storefront would recognize: a
shopper fills a cart, places it as an order, the order captures an immutable
record of what was bought and at what price, a payment is authorized against
it, and billing/shipping addresses travel with the order. The new model is a
structurally different shape from the legacy one — distinct mutable-Cart and
immutable-Order aggregates, three orthogonal status axes, money-minor line
snapshots, a Payment aggregate, and snapshotted Addresses. Because no
production data exists (the project has never been deployed), the legacy model
is torn down in a clean cut rather than reshaped in place.

This ADR records the shape of the rebuilt chain. The implementation lands as a
sequence of foundation-then-operations changes; this decision is the contract
every one of them honors.

## Decision

### 1. Two aggregates in one bounded context, one-shot conversion at place-time

The retail microservice keeps its single bounded context but splits it into two
modules' worth of aggregates:

- A **mutable `Cart`** (root) owning **`CartLine`** children — the shopper's
  editable working set.
- An **immutable `Order`** (root) owning **`OrderLine`** children — the placed
  record.

Placing an order is a **one-shot conversion**: at place-time the cart's lines
are snapshotted into order lines (variant id, quantity, and the unit/line money
amounts as they stood at that instant) and the cart is marked `converted`. A
placed order is an immutable snapshot that **no later cart edit can corrupt** —
editing the (now-converted) cart cannot mutate the order. This is preferred over
a single mutable Order edited in place, which would let post-purchase cart
churn rewrite the historical record.

### 2. Three orthogonal status fields on `Order`

`Order` carries **three independent status axes** rather than one combined
lifecycle field:

- `status` — `pending` / `confirmed` / `cancelled` / `shipped` / `delivered`
- `paymentStatus` — `none` / `authorized` / `captured` / `refunded` / `failed`
- `fulfillmentStatus` — `unfulfilled` / `partially-shipped` / `shipped` /
  `delivered`

Payment progress and fulfillment progress evolve **independently** of the order
lifecycle (an order can be `confirmed` with payment `authorized` and
fulfillment still `unfulfilled`). Collapsing these into one enum would force
illegal or ambiguous intermediate states; three orthogonal axes keep each
concern's transitions self-contained.

### 3. Authorize on place, capture explicit

Placing an order **auto-authorizes** payment inline through a `PAYMENT_GATEWAY`
port; **Capture is a separate, explicit operation**. Authorization reserves the
funds at place-time (the common storefront default), while capture — taking the
money — is deferred to an operator/fulfillment action. Ship-triggered
auto-capture is a later fulfillment capability, not part of this chain.

### 4. A `PAYMENT_GATEWAY` port with a fake default adapter, inside the orders module

Payment integration sits behind a **`PAYMENT_GATEWAY` port**; the default
binding is a **`FakePaymentGatewayAdapter`** that always authorizes. A real
gateway swaps in later by rebinding the port — no use case changes.

The **`Payment` aggregate + the port + the adapter live inside the `orders/`
module**, not in a standalone `payment/` module. Payment is part of the
order/checkout context — its operations act on the `Order` aggregate (they read
and advance `order.paymentStatus`). A separate module would introduce
cross-module domain coupling to `Order` for no isolation benefit. This is a
deliberate simplification of looser "payment service" framing: colocation keeps
the checkout domain cohesive.

### 5. Polymorphic `Address`, snapshotted onto each placed order

An **`Address`** is polymorphic over `ownerType ∈ {customer, order}`. At
place-time the order's billing and shipping addresses are **snapshotted** —
written as immutable `ownerType = order` rows copied from whatever the buyer
supplied. An order's address rows are **copies, not references** into a customer
address book. A reusable customer address book (`ownerType = customer`) is a
later capability; the polymorphic column shape accepts it from day one without a
schema change.

### 6. OCC `version` now; idempotency header accepted, enforcement deferred

`cart` and `order` ship a **`version` optimistic-concurrency column now**, even
though no concurrency guard consumes it yet — retrofitting an OCC column onto a
populated table later is a destructive `ALTER TABLE`, so the column is cheapest
to add up front (the same reasoning ADR-027 used for `stock_level.version`).

The **`Idempotency-Key` header is accepted** on Place and Capture now, but
**dedupe enforcement (a persisted idempotency store) is deferred** to a later
capability. Repeat-place idempotency in this chain is instead driven by **cart
state**: a placed cart is `converted`, and re-placing a converted cart returns
the order it already converted into rather than creating a second order.

### 7. Customer self-service authorization = authenticated + ownership check

Customer-facing cart and order routes are authorized by **a valid bearer token
plus an ownership check in the use case** — *not* by a customer permission code.
[ADR-024](024-rbac-v2-staffuser-customer-and-permissions.md) fixes that customer
tokens carry **no `permissions` claim**, so a
`@RequiresPermission('customer:own-orders:read')` gate would reject the very
customers it is meant to admit. Instead, the customer routes require
authentication and the use case compares the authenticated principal's id to the
resource's `customerId`; a mismatch is refused.

Staff overrides ride the existing permission model: `order:read` (existing) lets
support staff read any order, and `order:capture` (new, added with the
read/capture operation) gates the staff capture action. This **upholds ADR-024**
and explicitly **declines to introduce a customer permission code**.

### 8. The cross-service confirm flow is retired on the retail side

The legacy `INVENTORY_CONFIRM_GATEWAY` port and `ConfirmOrderUseCase` are
**deleted**. The retail side no longer calls `inventory.order.confirm`. The
inventory `inventory.order.confirm` deprecation stub and the
`IProductStockOrderConfirmPayload` contract remain a **reserved surface** owned
by ADR-027 — they are removed when the inventory-reservation capability lands,
not here. (The kept contract was made self-contained when the legacy retail
`IOrderProductConfirm` / `OrderProductStatusEnum` it imported were deleted.)

### 9. Routing keys

The six legacy `retail.order.*` keys (`retail.order.create` / `.confirm` /
`.get` / `.created` / `.confirmed` / `.cancelled`) are **retired** from both
`ROUTING_KEYS` and the mirrored `MicroserviceMessagePatternEnum`. They are
replaced by `retail.cart.*`, `retail.order.placed`, and `retail.payment.*` keys
introduced by the operations that emit them. This change removes only the
legacy keys; the new keys arrive with their producers.

## Alternatives Considered

1. **A single mutable `Order` edited in place (no separate `Cart`).** Rejected —
   a placed order must be an immutable record; letting later edits rewrite it
   corrupts the audit/history guarantee (§1).
2. **One combined status field.** Rejected — payment, fulfillment, and the order
   lifecycle are three independent concerns; one enum forces illegal
   intermediate states (§2).
3. **A standalone `payment/` module.** Rejected — Payment's operations touch the
   `Order` aggregate, so a separate module buys cross-module domain coupling for
   no isolation benefit (§4).
4. **A customer permission claim to gate customer routes.** Rejected — customer
   tokens carry no `permissions` claim under ADR-024, so the gate would reject
   the customers it targets; ownership checks are the correct model (§7).
5. **An incremental in-place schema refactor of the legacy order tables.**
   Rejected — the new model is a structurally different shape and there is no
   production data to preserve, so a clean cut carries less risk than threading
   an `ALTER`-heavy migration through four legacy tables (Context).

## Consequences

- The legacy retail order model is gone: the `order` / `order_product` /
  `order_status` / `order_product_status` tables are dropped, the retail
  `orders` module and the gateway `retail` module are removed, the notification
  order consumer is retired, the legacy `libs/contracts/retail` order contracts
  are emptied, and the six `retail.order.*` keys are retired. The retail
  microservice boots **order-free** (listening on `retail_queue` with no
  handlers) until the rebuilt aggregates land.
- The surviving `customer` table is the **gateway auth aggregate** (`CHAR(36)`
  UUID PK, [ADR-024](024-rbac-v2-staffuser-customer-and-permissions.md)), **not**
  a retail table. It is the FK target the rebuilt `order` / `cart` tables
  reference; it is **not** dropped by this chain.
- The rebuilt aggregates (`Cart`/`CartLine`, `Order`/`OrderLine`, `Payment`,
  `Address`), their tables, the `PAYMENT_GATEWAY` seam, the cart/order/payment
  operations, the new routing keys, and the notification re-point all land in
  subsequent changes that honor this decision.
- `inventory.order.confirm` stays a typed deprecation stub; its eventual removal
  is owned by the inventory-reservation capability (ADR-027), not by this chain.

## References

- [ADR-013](013-order-aggregate-and-cross-service-confirm.md) — the legacy
  `Order` aggregate + cross-service confirm flow this decision supersedes.
- [ADR-024](024-rbac-v2-staffuser-customer-and-permissions.md) — the
  StaffUser/Customer split and the no-`permissions`-claim fact that makes
  customer routes ownership-checked (§7).
- [ADR-027](027-stocklevel-running-totals-and-stocklocation.md) — the inventory
  rebuild that left `inventory.order.confirm` a reserved deprecation stub and
  owns its removal (§8).
- [ADR-008](008-rabbitmq-via-libs-messaging.md) — the dotted routing-key
  convention and the `ROUTING_KEYS` ↔ `MicroserviceMessagePatternEnum`
  value-for-value agreement the key retirement upholds (§9).
- [ADR-019](019-typeorm-and-mysql-for-persistence.md) — the hand-authored
  migration workflow (`synchronize` off) the table drop follows.
