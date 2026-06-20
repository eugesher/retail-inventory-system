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

## 6. The operations

The lifecycle is driven by eight retail RPCs. Each is served by the returns controller off
`retail_queue`, maps to one use case, walks at most one status transition, and resolves a
`ReturnRequestView`. `retail.return.inspect` additionally drives the cross-service restock
of fit-for-resale goods — see
[`02-return-line-disposition-and-restock.md`](02-return-line-disposition-and-restock.md).

| RPC                        | Use case                       | Actor / permission                   | Transition            | Event                       |
| -------------------------- | ------------------------------ | ------------------------------------ | --------------------- | --------------------------- |
| `retail.return.open`       | `OpenReturnRequestUseCase`     | owner **or** staff `order:return-authorize` | → `requested`  | `retail.return.requested`   |
| `retail.return.authorize`  | `AuthorizeReturnUseCase`       | staff `order:return-authorize`       | `requested → authorized` | `retail.return.authorized`  |
| `retail.return.reject`     | `RejectReturnUseCase`          | staff `order:return-authorize`       | `requested → rejected`   | `retail.return.rejected`    |
| `retail.return.receive`    | `ReceiveReturnUseCase`         | warehouse `inventory:receive-return` | `authorized → received`  | `retail.return.received`    |
| `retail.return.inspect`    | `InspectAndDispositionUseCase` | warehouse `inventory:receive-return` | `received → inspected`   | `retail.return.inspected`   |
| `retail.return.close`      | `CloseReturnUseCase`           | staff `order:return-authorize`       | `inspected → closed`     | `retail.return.closed`      |
| `retail.return.get`        | `GetReturnUseCase`             | owner **or** staff `order:read`      | — (read)              | —                           |
| `retail.return.list`       | `ListReturnsForOrderUseCase`   | owner **or** staff `order:read`      | — (read)              | —                           |

**Open** is the only operation that runs the policy gates the aggregate cannot enforce for
itself (it can see neither the order nor sibling RMAs): it resolves the order through the
raw-SQL reader (§8), runs the **owner-or-staff** check, the **return window** (§7), and the
**returnable-quantity** invariant (§8), then opens the `ReturnRequest` and lets the
repository finalize the `RMA-<year>-<pad8(id)>` number from the generated id. The event is
built **after** persistence concretizes the ids (the `Order.place` precedent), never pulled
from the aggregate.

**Authorize / Reject / Receive / Close** are thin: they resolve the RMA by id
(`RETURN_NOT_FOUND` if missing — the staff gate is enforced at the gateway, so the use case
trusts the resolved flag), call the matching domain mutator (which enforces the legal
transition — `RETURN_INVALID_STATUS_TRANSITION` on an illegal start), persist, and emit.
Authorize re-running the window/condition check is deliberately omitted — the substantive
eligibility gate was Open; Authorize is the staff's approval of an already-validated
request. **Reject** records its optional `reason` by appending it to the RMA's `notes` (the
domain `reject(at, reason)` does the append) — kept in `notes` so no schema column is
needed; the reason also rides the `retail.return.rejected` event.

**Get / List** are **owner-or-staff** reads: Get throws `RETURN_ACCESS_FORBIDDEN` for a
non-owner-non-staff caller, while List filters to the caller's own RMAs (a non-owner gets an
empty list with no existence leak — the own-only-list posture). The owner-check compares the
RMA's `customerId` (the buyer, copied from the order at Open) against the resolved actor; a
permission code is a **staff override** over that check, never a customer gate.

## 7. The return window

Return eligibility is governed by `RETURN_WINDOW_DAYS` (a `Joi.number().integer().positive()`
env with a **default of 30**, so a missing var never fails boot — the
`RESERVATION_TTL_MINUTES` precedent). It is read into the Open use case through a
`ConfigService`-backed value provider (`RETURN_WINDOW_DAYS` symbol) so the use case injects a
plain `number` and never touches env directly.

The rule, measured against the order's **fulfillment** axis (the lifecycle axis stays
`pending` after a ship, so it cannot be used here):

- **`delivered` → always returnable.** Delivery is the most generous start; once the buyer
  has the goods, the window is treated as open for this capability.
- **`shipped` / `partially-shipped` → returnable only within the window.** The goods have
  physically left, so the window is measured from the ship date: returnable iff
  `now ≤ shippedAt + RETURN_WINDOW_DAYS`. Past that → `RETURN_WINDOW_EXPIRED` (409).
- **anything else (unfulfilled, including a cancelled order that never shipped) → not
  returnable** → `RETURN_ORDER_NOT_RETURNABLE` (409).

The `shippedAt` the window is measured from is rolled up from the order's `fulfillment` rows
(`MIN(shipped_at)` — the first ship; with `MAX(delivered_at)` as a fallback) by the reader.

## 8. The cross-module order read

The returns module **must never import the orders module** (the per-module isolation rule,
ADR-004 / ADR-017 — the boundaries lint forbids importing `OrderEntity` /
`IOrderRepositoryPort`). But Open needs the order header (owner, fulfillment status, ship
date) and lines (ordered + cancelled quantities) to run its gates. So it reads them through a
**raw-SQL reader port**, `RETURN_ORDER_READER` (`IReturnOrderReaderPort`), exactly as the
orders module reads the cart tables via `ORDER_CART_READER` (ADR-028) and pricing reaches the
catalog-owned `product_variant.tax_category_id` (ADR-026 §5). Its adapter
(`ReturnOrderReaderTypeormAdapter`) issues parameterized SQL over `order` / `order_line`
(+ `fulfillment` for the ship/delivery roll-up) through the injected `EntityManager`; the
opaque shared FKs (`order.id`, `order_line.order_id`) are the only coupling, and `order` —
a SQL reserved word — is backticked. Domain/contract types only leave the port; no `typeorm`
type leaks into the use case.

### The returnable-quantity formula

Per requested line, the Open use case enforces:

```
requested ≤ ordered − cancelled − already-returned
```

- **`ordered`** is `order_line.quantity`.
- **`cancelled`** is read from the line's status: a line cancelled to the `cancelled` status
  removes its full ordered quantity from the pool. (Partial-quantity line cancellation is not
  persisted — Cancel Line only releases the allocation — so it cannot be read back; a
  documented limitation.)
- **`already-returned`** is `Σ return_line.quantity` per `order_line` across the order's
  **non-rejected** RMAs. A **rejected** RMA frees its quantity back to the pool (the buyer can
  re-request it). This sum is computed in the use case from
  `RETURN_REQUEST_REPOSITORY.listByOrderId` (excluding `rejected`), rather than a second SQL
  method on the reader — it reuses the existing repository read and keeps the order reader
  focused on the orders tables alone.

An unknown `orderLineId` → `RETURN_ORDER_LINE_NOT_FOUND` (404); an over-request →
`RETURN_QUANTITY_EXCEEDS_RETURNABLE` (409).

## 9. Eventing

The six lifecycle events split across two queues by the **producer-targets-consumer-queue**
pattern (ADR-008 / ADR-020), emitted best-effort post-commit (a publish failure is
warn-logged and swallowed — the transition has already committed) through the returns
context's events `ClientProxy` holder, `ReturnRabbitmqPublisher` (two clients, the
`OrderRabbitmqPublisher` precedent — the cross-service restock RPC rides a separate
`INVENTORY_RESTOCK_GATEWAY` adapter, see §6):

- **`retail.return.requested` / `.authorized` / `.received` / `.inspected`** — the
  buyer-facing events — are emitted onto **`notification_events`** (the notification service's
  own queue) so they land where its returns fan-out consumer will bind them.
- **`retail.return.rejected` / `.closed`** — the internal-status events — are emitted onto
  **`retail_queue`** (the producer's own queue) as reserved surfaces (no consumer today; the
  later refund capability is the natural consumer of `.closed`, since a closed RMA with money
  owed triggers a refund).

Each event is a plain wire interface extending `ICorrelationPayload` + `occurredAt`
(ADR-011 — a domain object is never serialized across services); the use case maps the saved
aggregate onto it after persistence assigns the ids. The new dotted routing keys are mirrored
value-for-value across `ROUTING_KEYS` (`libs/messaging`) and `MicroserviceMessagePatternEnum`
(`libs/contracts`), asserted by the lock-step `routing-keys.constants.spec.ts` (ADR-008).

## 10. Related documents

- [ADR-032 — Returns and refunds: the RMA lifecycle and restock](../../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md)
  — the decision record for the whole returns + refunds capability (module placement,
  the lifecycle, refund as a distinct entity, restock-from-return, eventing, audit).
- [ADR-028 — Cart, Order, Payment, and Address: the rebuilt checkout chain](../../adr/028-cart-order-payment-and-address-chain.md)
  — the orders bounded context this capability builds on: the immutable `Order` /
  `OrderLine` keyed on opaque ids, the one-throwable-per-module convention, the
  `version`-ships-now and `order_number` "finalize a derived field" idioms the RMA
  number reuses, and the `ORDER_CART_READER` raw-SQL reader the order reader mirrors.
- The **refund-as-a-distinct-entity** document covers why `Refund` lives in `orders/`
  alongside `Payment` rather than inside the returns context.
