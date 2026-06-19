# The RMA lifecycle — the `ReturnRequest` aggregate and its state machine

This document introduces the **`ReturnRequest`** aggregate — the RMA (Return
Merchandise Authorization) record that drives a delivered or shipped order's return
through a six-state lifecycle. It covers the data + domain foundation: the model, the
two persisted tables, the repository port, the wire enums/views, and the migration.
The operations that act on it (Open, Authorize, Reject, Receive, Inspect, Close) are
described in the sibling operations document; the refund half of the capability is
covered in the refund documents listed at the end.

## 1. What a `ReturnRequest` is

A `ReturnRequest` is the record of a buyer asking to send goods back from an order
that has already shipped or been delivered. It names the `orderId` the goods came from
and the `customerId` who bought them (copied from the order), carries a coarse
`reasonCategory` (defective / not-as-described / changed-mind / wrong-item) and an
optional free-text `notes`, and walks a status machine from the buyer's request
through to settlement.

Its `ReturnLine` children say **which `OrderLine` quantity is coming back**. A line
points back at a placed `order_line` by id and carries a `quantity` — the number of
units of that order line being returned. A partial return carries fewer units than
were ordered.

Three per-line fields — `condition` (new / damaged / used), `disposition` (restock /
scrap / quarantine), and `lineRefundAmountMinor` — are **recorded at inspection**, not
at request time. They are `null` from Open until the warehouse physically receives the
goods and inspects them. This is the natural shape of a return: the buyer says *what*
they want to send back and *why*; the warehouse later determines *what condition* it
arrived in, *what to do with it*, and *how much* it earns back.

`orderLineId` and `customerId` are **cross-aggregate / cross-service links** the
returns domain never dereferences by import:

- `orderLineId` points back at the placed order's line. The foreign key to
  `order_line(id)` lives only in persistence; the domain treats it as opaque data (the
  returns module never imports the orders module).
- `customerId` is the gateway customer's UUID — the same `CHAR(36)` value
  `order.customer_id` carries. It is a string, **not** a numeric id; the order and
  order-line ids that bracket it are numeric BIGINTs, but the customer is the auth
  aggregate's UUID.

## 2. Why it is its own bounded context

`ReturnRequest` / `ReturnLine` live in a **new retail bounded context** —
`apps/retail-microservice/src/modules/returns/` — not as sibling aggregates inside the
existing `orders/` module. The reason is the shape of the work it drives:

- The RMA lifecycle is a substantial **six-state machine** with **warehouse-facing
  operations** (Receive, Inspect) that are distinct from order placement. Folding it
  into `orders/` would balloon a module that already owns four aggregates (`Order`,
  `Payment`, `Address`, `Fulfillment`).
- The returns context gets its **own concrete throwable**, `ReturnDomainException`
  (with `ReturnErrorCodeEnum`), the same one-class-per-module convention
  `OrderDomainException` / `InventoryDomainException` / `CatalogDomainException`
  follow.

This is a deliberate contrast with **`Refund`**, which is a *sibling aggregate inside
`orders/`* rather than a member of the returns context — because a refund's operations
**mutate `Payment`**, and `Payment` lives in `orders/`. The split (the RMA lifecycle in
its own context; the refund where the payment lives) is recorded in
[ADR-032](../../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md).

Because the returns domain must never import the orders module (the per-module
isolation rule), the reads it needs from `order` / `order_line` at Open time (the
returnable-quantity and return-window checks) go through a **raw-SQL reader port**
declared with the Open use case — the same pattern the orders module uses to read the
cart tables. That reader is **not** part of this foundation; this layer ships only the
aggregate, its repository, and the wire contracts.

## 3. The six-state machine

`ReturnStatusEnum` (a wire contract, mapped to the `return_request.status` ENUM
column) has six values. The aggregate's mutators each walk exactly one legal
transition and bump the optimistic-concurrency `version`; an illegal start state
raises `ReturnDomainException(RETURN_INVALID_STATUS_TRANSITION)` (409).

| Transition                | Mutator           | Actor / permission           | Notes                                  |
| ------------------------- | ----------------- | ---------------------------- | -------------------------------------- |
| `requested → authorized`  | `authorize(at)`   | staff `order:return-authorize` | stamps `authorizedAt`                  |
| `requested → rejected`    | `reject(at)`      | staff `order:return-authorize` | **terminal**; stamps `closedAt`        |
| `authorized → received`   | `receive()`       | warehouse `inventory:receive-return` | goods logged in at the warehouse |
| `received → inspected`    | `markInspected()` | warehouse `inventory:receive-return` | per-line condition/disposition recorded |
| `inspected → closed`      | `close(at)`       | staff `order:return-authorize` | **terminal**; stamps `closedAt`        |

`rejected` and `closed` are terminal. **Open** (the `requested` entry state) is
owner-or-staff: the buyer who owns the order may open a return on it, and staff may
open one on the buyer's behalf; the same owner-or-staff rule governs the read
endpoints. The permission-per-transition mapping and the use cases that drive these
mutators are described in the operations document.

This is the RMA lifecycle that commerce platforms converge on — Adobe Commerce
(Magento), Vendure, and ReverseLogix all model a request → authorize → receive →
inspect → close progression with an early-rejection branch. Modeling it as an explicit
six-state machine (rather than a pair of booleans) keeps every transition guarded and
every illegal jump a typed 409.

## 4. Append-only

A return request is **append-only**. Rejection and closure are **status transitions**,
never row deletes — a rejected RMA stays in the table as a `rejected` row, a settled
one as a `closed` row, so the history of who returned what (and what was decided) is
never lost. The `deleted_at` column both tables inherit from `BaseEntity` stays
**inert** — the returns context never soft-deletes. This mirrors how `order`,
`fulfillment`, and the inventory `stock_movement` ledger treat cancellation/closure as
state, not deletion.

## 5. Schema

Two tables, created in foreign-key-dependency order (`return_request` first, then
`return_line`).

### `return_request`

| Column            | Type                                   | Notes                                            |
| ----------------- | -------------------------------------- | ------------------------------------------------ |
| `id`              | `BIGINT UNSIGNED` PK auto-increment     | the `BaseEntity` numeric PK widened to BIGINT    |
| `rma_number`      | `VARCHAR(20)` UNIQUE, nullable          | `RMA-<year>-<pad8(id)>`, finalized post-insert   |
| `order_id`        | `BIGINT UNSIGNED` FK → `order(id)`      | `ON DELETE RESTRICT`; plain scalar, no relation  |
| `customer_id`     | `CHAR(36)` FK → `customer(id)`          | `ON DELETE RESTRICT`; the gateway buyer UUID     |
| `status`          | `ENUM(...)` default `requested`         | the six-state lifecycle axis                     |
| `reason_category` | `ENUM(...)`                             | the coarse return reason                         |
| `notes`           | `TEXT`, nullable                        | optional free-text                               |
| `requested_at`    | `TIMESTAMP`                             | stamped at Open                                  |
| `authorized_at`   | `TIMESTAMP`, nullable                   | stamped at Authorize                             |
| `closed_at`       | `TIMESTAMP`, nullable                   | stamped at Reject / Close                        |
| `version`         | `INT` default 0 (`@VersionColumn`)      | per-RMA optimistic-concurrency token             |

Indexes: `UNIQUE(rma_number)`; `(order_id, requested_at DESC)`;
`(customer_id, requested_at DESC)` — the two descending composite indexes support the
newest-first list reads (by order, by customer).

### `return_line`

| Column                     | Type                                         | Notes                                          |
| -------------------------- | -------------------------------------------- | ---------------------------------------------- |
| `id`                       | `BIGINT UNSIGNED` PK auto-increment           | the `BaseEntity` numeric PK widened to BIGINT  |
| `return_request_id`        | `BIGINT UNSIGNED` FK → `return_request(id)`   | `ON DELETE CASCADE`; the owning request        |
| `order_line_id`            | `BIGINT UNSIGNED` FK → `order_line(id)`       | `ON DELETE RESTRICT`; opaque link, no relation |
| `quantity`                 | `INT`                                         | units of the order line coming back            |
| `condition`                | `ENUM(...)`, nullable                         | recorded at inspection (`null` until then)     |
| `disposition`              | `ENUM(...)`, nullable                         | recorded at inspection                         |
| `line_refund_amount_minor` | `BIGINT UNSIGNED`, nullable                   | recorded at inspection (minor units)           |

Index: `(order_line_id)`.

The owning request is mapped through the `@ManyToOne` relation alone — there is **no
separate `return_request_id` scalar** on the entity, the same shape `fulfillment_line`
/ `order_line` use. The `return_request_id` FK is `ON DELETE CASCADE` (a line cannot
outlive its request); every other FK is `ON DELETE RESTRICT` (a return never strands
its order, order line, or buyer, since the table is append-only).

### The RMA-number derivation

`rma_number` is **derived from the generated id**, not from a sequence table — the same
idiom `order.order_number` uses. The repository inserts the row with a `NULL`
`rma_number` (MySQL allows multiple `NULL`s under a UNIQUE index, so no provisional
token is needed — unlike the NOT-NULL `order_number`), reads back the auto-increment
id, then finalizes `rma_number = RMA-<year>-<pad8(id)>` in a targeted UPDATE keyed on
that id (the year is taken from `requested_at`). The save then re-reads the full graph
so the returned aggregate carries the concrete `return_line` ids, the finalized RMA
number, and the committed version.

### The collation footnote

`customer_id` is a `CHAR(36)` string foreign key, so the `return_request` table is
`COLLATE = utf8mb4_unicode_ci` — the same collation `customer`, `order`, and `cart`
use. MySQL refuses a foreign key between two string columns whose collations differ, so
matching the table collation is what lets the cross-table `customer_id` FK bind. (The
BIGINT `order_id` / `order_line_id` FKs have no collation concern.)

## 6. Related documents

- [ADR-032 — Returns and refunds: the RMA lifecycle and restock](../../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md)
  — the decision record for the whole returns + refunds capability (module placement,
  the lifecycle, refund as a distinct entity, restock-from-return, eventing, audit).
- [ADR-028 — Cart, Order, Payment, and Address: the rebuilt checkout chain](../../adr/028-cart-order-payment-and-address-chain.md)
  — the orders bounded context this capability builds on: the immutable `Order` /
  `OrderLine` keyed on opaque ids, the one-throwable-per-module convention, the
  `version`-ships-now and `order_number` "finalize a derived field" idioms the RMA
  number reuses.
- The returns **operations** document (Open / Authorize / Reject / Receive / Inspect /
  Close, the raw-SQL order reader, and the returnable-quantity invariant) completes the
  lifecycle half.
- The **refund-as-a-distinct-entity** document covers why `Refund` lives in `orders/`
  alongside `Payment` rather than inside the returns context.
