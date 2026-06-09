# Order and OrderLine — the immutable side of the rebuilt checkout

This change stands up the retail microservice's **immutable order record**: the
`Order` aggregate root, its `OrderLine` children, their two tables, the repository
contract, and the order wire contracts (three status enums + the line-status enum +
view DTOs). The polymorphic `Address` it snapshots is documented separately in
[06-address-polymorphic-snapshot.md](06-address-polymorphic-snapshot.md). It is
**foundation only** — there are no order use cases, no message handlers, and no
gateway routes yet; the retail microservice boots with the `orders` module
registered but serving nothing. Placing a cart as an order, authorizing payment,
capturing, and reading an order back all land in later capabilities.

The decision this implements is recorded in
[ADR-028](../../adr/028-cart-order-payment-and-address-chain.md); it is the
immutable counterpart to the mutable cart in
[02-cart-aggregate-and-q1-q3-decisions.md](02-cart-aggregate-and-q1-q3-decisions.md).

## Q4 — three orthogonal status fields, not one machine

A storefront order tracks **three concerns that progress on their own clocks**:

- **where the order is in its own lifecycle** — has it been placed, confirmed,
  cancelled?
- **how far payment has progressed** — nothing yet, authorized (funds reserved),
  captured (money taken)?
- **how far fulfillment has progressed** — nothing shipped, some shipped, all
  shipped, delivered?

`Order` models these as **three independent status fields** rather than one combined
lifecycle enum:

| Field | State set |
| --- | --- |
| `status` | `pending` · `confirmed` · `cancelled` · `shipped` · `delivered` |
| `paymentStatus` | `none` · `authorized` · `captured` · `refunded` · `failed` |
| `fulfillmentStatus` | `unfulfilled` · `partially-shipped` · `shipped` · `delivered` |

### Why three, not one

The three axes are **orthogonal** — a point in one says nothing forced about the
others. A perfectly ordinary order can sit at:

> `status = pending`, `paymentStatus = captured`, `fulfillmentStatus = unfulfilled`

— the shop has taken the money but has not yet picked the goods. Collapsing the
three into a single enum would force the modeller to either enumerate the whole
cross-product (`pending-paid-unshipped`, `pending-authorized-unshipped`, …) — a
combinatorial explosion that grows multiplicatively as each concern gains a state —
or to pick an arbitrary linear order that makes legal real-world combinations
*unrepresentable*. Three independent fields keep each concern's transitions
self-contained: a payment event advances only `paymentStatus`, a shipment event
advances only `fulfillmentStatus`, and neither has to reason about the other two.

The unit spec asserts this directly: it constructs an order with
`paymentStatus = captured` and checks `fulfillmentStatus` is still `unfulfilled` and
`status` still `pending`, and it checks that advancing payment
(`none → authorized → captured`) never moves the lifecycle or fulfillment axes.

This capability only ever writes the place-time defaults —
`status = pending`, `paymentStatus = none`, `fulfillmentStatus = unfulfilled` — plus
the two payment-axis transitions below. The lifecycle and fulfillment transitions
arrive with the confirmation and fulfillment capabilities that drive them; adding
ship/deliver/cancel mutators now would be dead, untested code.

### The payment axis is the only one with mutators here

`Order` exposes exactly two state mutators, both on the payment axis:

- `markPaymentAuthorized()` — `none → authorized` (the authorize-on-place
  capability)
- `markPaymentCaptured()` — `authorized → captured` (the explicit capture
  capability)

Each rejects an invalid starting state with a typed `OrderDomainException` and
**bumps the `version`** optimistic-concurrency token. `refunded` / `failed` ship in
the enum for later refund/decline capabilities but have no producer yet.

## The immutable Order and money-minor line snapshots

An `Order` is the **placed record of what was bought and at what price** — the
counterpart to the mutable `Cart` it converts from. Placing an order is a
**one-shot conversion**: the cart's lines are snapshotted into `OrderLine`s and the
cart is marked `converted`. Because the order is a *copy* taken at the instant of
purchase, no later cart edit can reach it — the two graphs share no rows. This is
what protects the historical record (the same two-aggregate reasoning the cart doc
sets out from the other side).

Each `OrderLine` is a **fully immutable snapshot**:

- `variantId` — the opaque catalog backbone key (no `ProductVariant` import).
- `sku`, `nameSnapshot` — the product identity *as it read at purchase*, so a later
  rename or re-SKU in the catalog never rewrites the buyer's record.
- `unitPriceMinor` — the unit price *as it stood at purchase*, decoupled from any
  later pricing change.
- `quantity`, `taxAmountMinor`, `discountAmountMinor`, `lineTotalMinor`, `status`.

The line carries **no setters** and is `Object.freeze`-d at construction, so the
immutability is real at runtime, not merely a compile-time `readonly` hint — any
write throws. (`OrderLine extends Entity`, not `AggregateRoot`, so there is no
`pullDomainEvents()` reassignment that freezing would break — unlike `Order` and
`Address`.) The unit spec asserts a write to `sku` / `nameSnapshot` /
`unitPriceMinor` throws.

All money lives in **minor units** (integer cents) — never a float. A line's
`lineTotalMinor = unitPriceMinor × quantity + taxAmountMinor − discountAmountMinor`;
the line derives it when omitted and *asserts* it when supplied (the load path), so
a corrupted stored total is rejected on read.

### The total invariant

`Order` enforces a header/line reconciliation at construction (the spec asserts it):

```
subtotalMinor   = Σ line.lineTotalMinor
grandTotalMinor = subtotalMinor + taxTotalMinor + shippingTotalMinor − discountTotalMinor
```

In **this** capability `taxTotalMinor`, `discountTotalMinor`, and
`shippingTotalMinor` are always **0**, so the invariant reduces to
`grandTotalMinor = subtotalMinor = Σ line.lineTotalMinor`. The zeros are deliberate,
not a stub: there is no tax, discount, or shipping capability yet. The
`tax_category` that exists today is a **classification label only** — it carries no
rate, jurisdiction, or computation
([ADR-026](../../adr/026-price-append-only-ledger-and-tax-category.md)) — and tax
computation, discounts, and shipping rating are later (or excluded) capabilities.
Shipping the columns now (defaulting `0`) means those capabilities populate existing
columns rather than running a destructive `ALTER TABLE` on a populated table. The
`place` factory derives all five totals from the already-snapshotted lines, so the
header can never disagree with the lines at placement; `reconstitute` re-asserts the
invariant on the load path.

## The `version` optimistic-concurrency token

`Order` carries a `version` column **now**, even though no concurrency guard
consumes it yet. The aggregate advances it on every mutation; TypeORM's
`@VersionColumn` owns the *persisted* value (it increments on each managed write).
Shipping the column up front keeps a later concurrency-hardening retrofit
non-destructive — adding an optimistic-lock column to a populated table is an
`ALTER TABLE` on live data — the same forward-provisioning the inventory
`stock_level.version` used.

> The domain's in-memory `version` (which makes "version bumps on each mutation"
> observable in a unit test) and TypeORM's persisted `@VersionColumn` are
> **separate**: the mapper deliberately never writes `version`, so the persisted
> count reflects TypeORM's own increment per managed save, not the domain's. A
> freshly placed order reads back at a higher persisted version than the domain's
> `0` because the first save is an INSERT followed by the `order_number` UPDATE (see
> below) — two managed writes.

## `order_number` — derivation and uniqueness backstop

`order_number` is a human-facing, unique, immutable label of the form
`ORD-<year>-<8-digit-zero-padded-sequence>` (e.g. `ORD-2026-00000001`). For this
walking skeleton it is **derived from the order's own generated id**, finalized
inside `OrderTypeormRepository.save` (the "re-read the saved graph, then finalize a
derived field" idiom):

1. On a **new** order the first insert needs a non-null, `UNIQUE` `order_number`,
   but the binding value depends on the not-yet-assigned id. So the insert writes a
   **guaranteed-unique provisional token** (`TMP-<16 hex>`, 20 chars), the
   transaction reads back the generated BIGINT id, derives
   `ORD-${placedAt.getUTCFullYear()}-${String(id).padStart(8, '0')}`, and `UPDATE`s
   the row. The provisional never commits — it is overwritten before the
   transaction closes.
2. On a **re-save** (a payment-status/version bump) `order_number` is **immutable**:
   the root update omits it entirely, so it is never rewritten.

Uniqueness is backed by the `UC_ORDER_NUMBER` UNIQUE index on `order.order_number`,
and by construction — the number embeds the row's own globally-unique id. The
`IOrderRepositoryPort.nextOrderNumber()` method formats the *next* number from the
current max id as a **non-binding preview** for a caller that wants to display one;
the binding value is always the one `save` derives from the real id, so the two
agree. A dedicated monotonic sequence (decoupling the human number from the
auto-increment id, so gaps from rolled-back inserts don't show) is a later
refinement.

## The `source_cart_id` link makes repeat-place idempotent

`order.source_cart_id` records the cart this order converted from (FK to `cart`,
`ON DELETE SET NULL`). It is the hook for **repeat-place idempotency**: re-placing a
cart that already converted resolves — via
`IOrderRepositoryPort.findBySourceCartId(cartId)` — to the order it already became,
rather than creating a second order. (A placed cart is also marked `converted` and
frozen from the cart side, so the guard applies from both directions.) The place
use case that consumes this seam lands with the place capability; this foundation
only fixes the column and the lookup.

## The `order` / `order_line` schema

One migration creates both tables alongside the `address` table (`synchronize` stays
off — [ADR-019](../../adr/019-typeorm-and-mysql-for-persistence.md); FK-dependency
order is `address` → `order` → `order_line`):

| Table | Key columns | Notes |
| --- | --- | --- |
| `order` | `id BIGINT UNSIGNED` PK, `order_number VARCHAR(20)`, `customer_id CHAR(36)` NULL, `currency CHAR(3)`, three status `ENUM`s, five `BIGINT` money totals, `billing_address_id` / `shipping_address_id` / `source_cart_id CHAR(36)` NULL, `placed_at`, `version INT`, timestamps + inert `deleted_at` | `UC_ORDER_NUMBER` UNIQUE; `FK_ORDER_CUSTOMER → customer(id) ON DELETE SET NULL` (a deleted customer leaves an order tombstone, [ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)); `FK_ORDER_BILLING_ADDRESS` / `FK_ORDER_SHIPPING_ADDRESS → address(id)`; `FK_ORDER_SOURCE_CART → cart(id) ON DELETE SET NULL`; index on `(customer_id, placed_at)` |
| `order_line` | `id BIGINT UNSIGNED` PK, `order_id BIGINT UNSIGNED`, `variant_id BIGINT UNSIGNED`, `sku VARCHAR(64)`, `name_snapshot VARCHAR(255)`, `quantity INT`, four `BIGINT` money columns, `status ENUM`, timestamps + inert `deleted_at` | `FK_ORDER_LINE_ORDER → order(id) ON DELETE RESTRICT` (orders are append-only — a line is never orphaned); `FK_ORDER_LINE_VARIANT → product_variant(id) ON DELETE RESTRICT`; index on `order_id` |

All four bounded contexts share the one MySQL database, so `order.customer_id`,
`order.source_cart_id`, and `order_line.variant_id` are **real cross-context foreign
keys** onto the gateway `customer` aggregate, the retail `cart`, and the catalog
`product_variant` respectively. The CHAR(36) FK columns + both tables are
`utf8mb4_unicode_ci` so the FK collations match the referenced columns.

`deleted_at` exists on both tables because the entities extend `BaseEntity` (TypeORM
appends `deleted_at IS NULL` to every `find`, so the column must exist), but it stays
**inert** — an order and its lines are append-only, never soft-deleted.
`order_line.deleted_at` exists for the same reason `cart_line.deleted_at` does — a
`BaseEntity` child whose reads would otherwise fail (TypeORM appends
`deleted_at IS NULL` to every `find`).

### Persistence shape

`OrderEntity` / `OrderLineEntity` keep `BaseEntity`'s generated numeric PK (the
migration widens it to `BIGINT UNSIGNED`). `OrderLineEntity` maps the owning order
through the `@ManyToOne` relation alone — there is **no separate `order_id` scalar
column on the entity**; a child entity does not carry its parent's id in the domain,
so the relation-only mapping is the truer shape (the same shape `CartLineEntity`
uses, though here the FK is numeric so a twin mapping would also be legal).
`variant_id` is a plain `BIGINT` scalar with **no `@ManyToOne`** — the retail module
must not import the catalog `ProductVariantEntity` (the forbidden cross-module
import, [ADR-004](../../adr/004-adopt-hexagonal-architecture-per-service.md) /
[ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)); the FK lives
only in the migration.

`OrderTypeormRepository` is the single `@InjectRepository` site for the order graph.
Its `save` runs the root + line persistence inside one transaction, finalizes the
`order_number` on a fresh insert (above), and **re-reads the saved graph** so the
generated id and `order_line.id`s come back concrete, the `order_number` is the
finalized value, and the version + timestamps are the committed ones. It returns
domain types only — no TypeORM type leaks past it.

## Wire contracts

The order contracts live in `libs/contracts/retail` (plain TypeScript; Swagger
decorators on DTOs are the documented lib-contracts exception —
[ADR-005](../../adr/005-split-shared-common-into-bounded-libs.md)):

- **`OrderStatusEnum`** / **`OrderPaymentStatusEnum`** /
  **`OrderFulfillmentStatusEnum`** — the three orthogonal status axes, wire
  contracts because they surface on `OrderView` and map to the three ENUM columns.
- **`OrderLineStatusEnum`** — the per-line fulfillment state (`allocated` default).
- **`OrderView` / `OrderLineView`** — the RPC/HTTP response shapes (the view carries
  the five money totals and `lines: OrderLineView[]`; an optional `payment` field is
  added by the payment capability).

Unlike the catalog lifecycle enums (which stay internal to the catalog domain), the
order status enums are wire contracts from the start: a versioned response DTO
carries them and the gateway maps them straight through.
