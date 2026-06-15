# Fulfillment aggregate and the per-shipment fourth status axis

This document introduces the **`Fulfillment`** aggregate — the per-shipment record
that drives a placed order from `pending`/`authorized` toward `delivered`. It covers
the data + domain foundation: the model, the two persisted tables, the repository
port, and the wire enum/views. The operations that act on it (Create, Ship, Deliver,
Cancel) are described in the sibling documents listed at the end.

## 1. What a `Fulfillment` is

A `Fulfillment` is a **per-shipment, per-location** record. When some or all of a
placed order's lines physically leave a warehouse in a box, that shipment is one
`Fulfillment` row: it names the `stockLocationId` it ships from, carries a tracking
number / carrier, and is stamped `shippedAt` / `deliveredAt` as it progresses.

Its `FulfillmentLine` children say **which `OrderLine` quantity is in this shipment**.
A line points back at a placed `order_line` by id and carries a `quantity` — the
number of units of that order line included in *this* box.

Because a fulfillment is per-shipment and per-location, **partial and split shipments
fall out for free**:

- A **partial shipment** ships fewer units of a line than were ordered; the remainder
  ships later in a second `Fulfillment`. Each fulfillment line carries its own slice
  of the ordered quantity.
- A **split shipment** ships different lines (or different units of the same line)
  from different warehouses; each warehouse's box is its own `Fulfillment` with its
  own `stockLocationId`.

So one order resolves to a **list** of `Fulfillment`s, not a single shipment flag.

`stockLocationId` is an **opaque cross-service string** — the inventory
`stock_location` primary key. The retail service never imports the inventory module,
so the column is a plain scalar with no foreign key (the same opaque-id treatment the
reservation and stock-movement tables give their cross-service ids).

## 2. Why it lives in the `orders/` module

`Fulfillment` is a **sibling aggregate root inside the retail `orders/` module**, not
a new bounded context. Its operations act on the module's other aggregates:

- **Ship** advances the order's fulfillment axis, flips each shipped order line's
  status, and (the default policy) **captures the order's `Payment`**.
- **Cancel Order** settles the `Payment` (void or flag-for-refund) and cancels any
  still-pending fulfillments.

Because every fulfillment operation touches `Order` and `Payment`, the fulfillment
belongs in the same bounded context and **reuses the module's single throwable**,
`OrderDomainException` + `OrderErrorCodeEnum` — the same one-class-per-module
convention `Payment` and `Address` already follow. A standalone `fulfillment/` module
would have to re-import the orders context across a boundary, buying coupling for no
isolation gain. See [ADR-031](../../adr/031-fulfillment-aggregate-and-ship-triggered-capture.md)
§Decision and [ADR-028](../../adr/028-cart-order-payment-and-address-chain.md) §4.

The aggregate enforces **only its own shape**: at least one line, each line's quantity
a positive integer, the legal status transitions, and the tracking-on-ship rule. The
**cross-fulfillment invariant** — the sum of a line's quantities across *all* of an
order's shipments must not exceed the ordered quantity — is **not** in the model. The
aggregate cannot see its sibling fulfillments or the order's line quantities, so that
check belongs to the Create Fulfillment use case (which loads the order and the
order's existing fulfillments), surfaced as `FULFILLMENT_QUANTITY_EXCEEDS_REMAINING`.

## 3. Three orthogonal order statuses, plus the fulfillment's own

A placed `Order` carries **three orthogonal status axes** that evolve independently
(restating the checkout-chain decision):

- `Order.status` — the order **lifecycle**: `pending → confirmed → shipped →
  delivered`, or `cancelled`.
- `Order.paymentStatus` — **payment** progress: `none → authorized → captured`, or
  `refunded` / `failed`.
- `Order.fulfillmentStatus` — **fulfillment** progress: `unfulfilled →
  partially-shipped → shipped → delivered`.

They are independent by construction: a `captured` payment can coexist with an
`unfulfilled` fulfillment (paid but not yet shipped), and a `confirmed` lifecycle can
coexist with `partially-shipped` fulfillment.

`Fulfillment.status` (`FulfillmentStatusEnum` = `pending` / `shipped` / `delivered` /
`cancelled`) is a **fourth status axis** — but at a different grain. The three order
axes describe the *whole order*; the fulfillment axis describes *one shipment*. An
order with split shipments owns several `Fulfillment`s, each with its own status. The
order's own `fulfillment_status` is the **roll-up across them** (computed by the
operations, not stored on the fulfillment): `shipped` once every line is fully
shipped, otherwise `partially-shipped`.

**Worked example.** An order for 3 units of line A and 2 of line B ships the 3 A's
from `default-warehouse` today and the 2 B's tomorrow:

| Moment | `Order.status` | `Order.paymentStatus` | `Order.fulfillmentStatus` | Fulfillment #1 (A×3) | Fulfillment #2 (B×2) |
| --- | --- | --- | --- | --- | --- |
| placed | pending | authorized | unfulfilled | — | — |
| box 1 ships | confirmed | **captured** | **partially-shipped** | **shipped** | pending |
| box 2 ships | confirmed | captured | **shipped** | shipped | **shipped** |
| both delivered | **delivered** | captured | **delivered** | **delivered** | **delivered** |

Which operation advances which axis (the operations are detailed in the sibling
documents):

- **Ship** → the fulfillment's `pending → shipped`; the order's fulfillment axis to
  `partially-shipped`/`shipped`; the payment axis to `captured` (ship-triggered
  capture); each shipped order line's status.
- **Deliver** → the fulfillment's `shipped → delivered`; when every fulfillment of the
  order is delivered, the order's lifecycle **and** fulfillment axes to `delivered`.
- **Cancel Order** → the order lifecycle to `cancelled`; the payment to voided (or
  flagged for refund); any pending fulfillments to `cancelled`.

## 4. Append-only — cancellation is a status transition, never a delete

A `Fulfillment` is **append-only**. Cancelling a shipment flips its status to
`cancelled`; it never deletes the row. This keeps the shipment history intact (a
cancelled box still happened, historically) and is what lets Cancel Order reason about
"is there a `shipped` fulfillment?" without worrying about rows having vanished.

Both `FulfillmentEntity` and `FulfillmentLineEntity` extend the shared `BaseEntity`,
so they inherit a `deleted_at` soft-delete column (TypeORM appends `deleted_at IS
NULL` to every query). On these tables `deleted_at` stays **inert** — nothing ever
writes it. The lifecycle source of truth is `status`, exactly as the catalog/pricing/
inventory aggregates leave their inherited `deleted_at` inert in favour of an explicit
status flag.

A direct corollary: **a `shipped`/`delivered` fulfillment is never cancellable** (the
domain rejects `cancel()` from those states with
`FULFILLMENT_INVALID_STATUS_TRANSITION`). That single rule is what protects Cancel
Order's precondition — you can never strand physically-shipped stock by cancelling an
order around it.

## 5. Schema

Two tables, created by the `CreateFulfillmentTables` migration in FK-dependency order
(`fulfillment` first, then `fulfillment_line`).

**`fulfillment`**

| column | type | notes |
| --- | --- | --- |
| `id` | BIGINT UNSIGNED PK | auto-increment (the `BaseEntity` numeric id) |
| `order_id` | BIGINT UNSIGNED | FK → `order.id` `ON DELETE RESTRICT` |
| `stock_location_id` | VARCHAR(64) | opaque inventory id — **no FK** (retail never imports inventory) |
| `status` | ENUM | `pending` / `shipped` / `delivered` / `cancelled`, default `pending` |
| `tracking_number` | VARCHAR(64) NULL | stamped on ship |
| `carrier` | VARCHAR(64) NULL | optional metadata |
| `shipped_at` | TIMESTAMP NULL | stamped on ship |
| `delivered_at` | TIMESTAMP NULL | stamped on deliver |
| `version` | INT | the `@VersionColumn` optimistic-concurrency token |
| `created_at` / `updated_at` / `deleted_at` | TIMESTAMP | `deleted_at` inert |

Index `IDX_FULFILLMENT_ORDER_SHIPPED (order_id, shipped_at)` — supports listing an
order's fulfillments newest-first (a still-`pending` fulfillment has a null
`shipped_at`, which sorts last under `DESC`).

**`fulfillment_line`**

| column | type | notes |
| --- | --- | --- |
| `id` | BIGINT UNSIGNED PK | auto-increment |
| `fulfillment_id` | BIGINT UNSIGNED | FK → `fulfillment.id` `ON DELETE CASCADE` — a line cannot outlive its fulfillment |
| `order_line_id` | BIGINT UNSIGNED | FK → `order_line.id` `ON DELETE RESTRICT` |
| `quantity` | INT | units of that order line in this shipment |
| `created_at` / `updated_at` / `deleted_at` | TIMESTAMP | `deleted_at` inert |

Index `IDX_FULFILLMENT_LINE_ORDER_LINE (order_line_id)`.

The owning fulfillment is mapped on the entity through the `@ManyToOne` relation alone
(its `@JoinColumn` *is* the `fulfillment_id` column) — a child entity carries no
duplicate scalar parent-id column, the same shape `order_line` and `cart_line` use.
The `@VersionColumn` lives on the root only; the repository persists the root + its
lines in **one transaction** and re-reads the saved graph so the generated ids come
back concrete (the "re-read the saved graph" idiom the order/payment repositories
follow). The repository is the single `@InjectRepository(FulfillmentEntity)` site and
returns domain types only — no TypeORM type leaks past it (the architecture-boundary
rule).

## Cross-links

- [ADR-031 — Fulfillment aggregate and ship-triggered capture](../../adr/031-fulfillment-aggregate-and-ship-triggered-capture.md)
  — the decision record for the whole capability.
- [ADR-028 — Cart, Order, Payment, and Address](../../adr/028-cart-order-payment-and-address-chain.md)
  — the three orthogonal order axes and the one-throwable-per-module convention this
  aggregate extends.
- `02-create-and-ship-fulfillment.md` *(forthcoming)* — creating a fulfillment from an
  order's lines (with the cross-fulfillment sum invariant) and shipping it.
