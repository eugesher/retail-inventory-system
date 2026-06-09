---
epic: epic-05
source_epic_file: tmp/epics/epic-05-cart-order-payment-walking-skeleton.md
---

# epic-05 — Task Index

This epic is decomposed into **9 self-contained tasks**, each sized for a single
cold-start session. Every task file states its **entry state** (what prior tasks
left on disk and in the `retail_db` schema), the **concrete files** it
adds/modifies/deletes, the **tests** it must write, its **doc deliverable**, and
its **exit criteria**. A task assumes nothing about future tasks; it relies only
on the repository as committed by prior tasks plus the `carryover-*.md` notes in
this folder. Run them strictly in order — there is no parallelism.

The capability delivered: the **Stage-1 order chain, end-to-end**. The legacy
`order` / `order_product` model (one row per unit, two-value status, a
cross-service "confirm → reserve stock" RPC) is torn out and rebuilt as two
distinct aggregates in the retail microservice — a mutable **`Cart`** (with
`CartLine`) and an immutable **`Order`** (with `OrderLine`) — joined by a
**one-shot conversion** at place-time. `Order` carries three orthogonal status
fields (`status`, `paymentStatus`, `fulfillmentStatus`). A **`Payment`**
aggregate sits behind a `PAYMENT_GATEWAY` port with a `FakePaymentGatewayAdapter`
default, and a polymorphic **`Address`** is snapshotted onto each placed order.
Place Order snapshots each line's `sku` / `nameSnapshot` / `unitPriceMinor` /
`taxAmountMinor` / `lineTotalMinor` by reading the catalog's variant metadata and
applicable price over RabbitMQ at write-time. The seven Stage-1 operations ship:
Add to Cart, Remove / Change Quantity, Get Cart, Place Order (auto-authorizes
payment), Capture Payment (explicit), Get Order, List My Orders. The notification
chain is repointed from the retired `retail.order.created` to the new
`retail.order.placed`. **Reservation / allocation, fulfillment / ship, cancel,
returns / refunds, a real payment gateway, idempotency-key dedupe, and OCC
enforcement are explicitly out of scope** (owned by later capabilities — see each
task's *Scope → Out*); the `version` columns and the `Idempotency-Key` header
ship now so those retrofits are non-destructive.

## Sequence and dependencies

| # | Task | Touches | Doc deliverable |
|---|---|---|---|
| 1 | [Tear down the legacy order model; retire its keys, contracts, consumer, seeds, routes](task-01-drop-legacy-order-model-and-retire-surface.md) | `apps/retail-microservice/src/modules/orders/` (deleted), `apps/api-gateway/src/modules/retail/` (deleted), `apps/notification-microservice/.../consumers/order-events.consumer.ts` (+ use case, deleted), `libs/contracts/retail/` (gutted), `libs/messaging/routing-keys.constants.ts` (+ spec), `libs/contracts/microservices/microservice-message-pattern.enum.ts`, `migrations/`, `scripts/seeds/order*.sql` (deleted), `scripts/utils/test-db-seed.util.ts`, both app modules, `test/system-api.e2e-spec.ts` / `test/notification.e2e-spec.ts` / `test/auth.e2e-spec.ts`, `CLAUDE.md`/`README.md` (dropped-route lines only) | `01-retail-rebuild-and-old-tables-dropped.md` + **ADR-028** |
| 2 | [Cart + CartLine aggregate foundation](task-02-cart-aggregate-foundation.md) | `apps/retail-microservice/src/modules/cart/` (new: domain, persistence, repo port), `apps/retail-microservice/src/app/app.module.ts`, `libs/contracts/retail/` (cart enums/views/events), `libs/messaging/routing-keys.constants.ts` (+ spec), `libs/contracts/microservices/`, `migrations/` | `02-cart-aggregate-and-q1-q3-decisions.md` (started) |
| 3 | [Order + OrderLine + Address aggregate foundation (three orthogonal statuses, line snapshots, polymorphic address)](task-03-order-orderline-address-foundation.md) | `apps/retail-microservice/src/modules/orders/` (new: domain, persistence, repo port), `apps/retail-microservice/src/app/app.module.ts`, `libs/contracts/retail/` (order/address enums/views), `migrations/` | `03-order-three-status-and-q4-decision.md` + `06-address-polymorphic-snapshot.md` |
| 4 | [Payment aggregate + `PAYMENT_GATEWAY` port + `FakePaymentGatewayAdapter`](task-04-payment-and-gateway-port.md) | `apps/retail-microservice/src/modules/orders/` (payment domain, port, persistence, `infrastructure/payment-gateway/`), `libs/contracts/retail/` (payment enums/views), `migrations/` | `05-payment-gateway-port-and-fake-adapter.md` |
| 5 | [Cart operations end-to-end + gateway `modules/cart/` + guest cart promotion (Q1/Q7)](task-05-cart-operations-and-gateway.md) | `apps/retail-microservice/src/modules/cart/{application,infrastructure,presentation}/`, `apps/api-gateway/src/modules/cart/` (new), `apps/api-gateway/src/app/app.module.ts`, `apps/api-gateway/src/modules/auth/` (guest-customer creation, re-exported `CUSTOMER_REPOSITORY`), `libs/messaging/`, `http/cart.http` (new), `test/guest-cart-promotion.e2e-spec.ts`, `test/cart-operations.e2e-spec.ts` | `02-cart-aggregate-and-q1-q3-decisions.md` (completed) |
| 6 | [Place Order: cross-service snapshots, authorize payment, events, gateway place endpoint, `Idempotency-Key` (Q10)](task-06-place-order-and-authorize.md) | `apps/retail-microservice/src/modules/orders/{application,infrastructure,presentation}/`, `apps/api-gateway/src/modules/cart/` (place route), `libs/contracts/retail/` (place events), `libs/messaging/` (+ spec), `test/cart-to-order-walking-skeleton.e2e-spec.ts` (steps 1–5) | `04-order-line-snapshot-and-cross-service-lookup.md` + `07-authorize-on-place-capture-explicit-q5.md` (started) + `08-idempotency-key-header-q10.md` |
| 7 | [Capture Payment + Get Order + List My Orders + gateway `modules/orders/` (owner-check) + `order:capture` permission + seed](task-07-capture-get-list-and-gateway-orders.md) | `apps/retail-microservice/src/modules/orders/{application,infrastructure,presentation}/`, `apps/api-gateway/src/modules/orders/` (new), `apps/api-gateway/src/app/app.module.ts`, `libs/contracts/auth/permission.enum.ts`, `libs/messaging/` (+ spec), `scripts/test-db-seed.ts`, `http/order.http` (rewritten), `test/cart-to-order-walking-skeleton.e2e-spec.ts` (steps 6–8), `test/order-list-my-orders.e2e-spec.ts` | `07-authorize-on-place-capture-explicit-q5.md` (completed) |
| 8 | [Repoint the notification consumer to `retail.order.placed`](task-08-notification-consumer-repoint.md) | `apps/notification-microservice/src/modules/notifications/{infrastructure/consumers,application/use-cases}/`, `libs/contracts/retail/` (consumed event), `test/notification.e2e-spec.ts` | `09-routing-keys-retired-and-added.md` |
| 9 | [Seed + docs + README/CLAUDE + lint-fixtures finalization](task-09-seed-docs-and-finalization.md) | `scripts/test-db-seed.ts` (example cart), `scripts/seeds/` (optional), `docs/implementation/05-cart-order-payment-walking-skeleton/10-*.md`, `README.md`, `CLAUDE.md`, `spec/architecture-lint.spec.ts` | `10-cart-and-order-http-files.md` (+ README / CLAUDE) |

## Carryover chain

Each task `NN` ends by writing `carryover-NN.md` in this folder. Each task `N`
begins by reading **every** prior `carryover-01.md … carryover-(N-1).md` in
order. The carryover files are the only transition markers and live only under
this folder — never in source, docs, `README.md`, or `CLAUDE.md`. Do the tasks
in order; do not parallelize.

## Document-deliverable map

Implementation docs live under
`docs/implementation/05-cart-order-payment-walking-skeleton/`. Each task writes
its own doc(s) **as part of its Definition of Done** (a task is not complete
until its doc explains the what and why). **Two docs are written across two
tasks** (noted below); the rest are authored whole by one task.

| Doc | Written by |
|---|---|
| `01-retail-rebuild-and-old-tables-dropped.md` | task-01 |
| `02-cart-aggregate-and-q1-q3-decisions.md` | task-02 (aggregate + Q3) **and** task-05 (Q1 guest promotion + operations) |
| `03-order-three-status-and-q4-decision.md` | task-03 |
| `04-order-line-snapshot-and-cross-service-lookup.md` | task-06 |
| `05-payment-gateway-port-and-fake-adapter.md` | task-04 |
| `06-address-polymorphic-snapshot.md` | task-03 |
| `07-authorize-on-place-capture-explicit-q5.md` | task-06 (authorize-on-place) **and** task-07 (explicit capture) |
| `08-idempotency-key-header-q10.md` | task-06 |
| `09-routing-keys-retired-and-added.md` | task-08 |
| `10-cart-and-order-http-files.md` | task-09 |

**ADR:** task-01 records **ADR-028** — the retail Stage-1 order chain
(`docs/adr/028-cart-order-payment-and-address-chain.md`): Cart and Order as two
distinct aggregates with one-shot conversion at place-time (Open Question Q3);
Order's three orthogonal status fields (Q4); authorize-on-place / capture-explicit
(Q5); the `PAYMENT_GATEWAY` port + `FakePaymentGatewayAdapter` seam; the
polymorphic, snapshot-on-order `Address`; the `version` OCC columns shipped now
though enforcement is deferred; the `Idempotency-Key` header accepted now though
dedupe is deferred (Q10); and the **customer self-service authorization model** —
authenticated **owner-checks at the use case**, *not* a customer permission code
(upholding ADR-024's "customer tokens carry no permissions claim"), with
`order:read` / `order:capture` as the staff overrides. It **supersedes ADR-013**
(`Order` aggregate + cross-service confirm flow), so task-01 flips ADR-013's
`Status` line to `Superseded by ADR-028` and adds a one-line pointer (the only
edit an accepted ADR may receive — ADR-003). The 3-digit number is allocated at
task-01's first commit; if `028` is taken when the task runs, take the next free
number and record it in `carryover-01.md`. No other task introduces an ADR; no
task may violate an accepted ADR.

**Note on the confirm seam:** the inventory `inventory.order.confirm` deprecation
stub and the `IProductStockOrderConfirmPayload` wire contract are **kept** by this
epic — task-01 deletes only the *retail-side caller* (`ConfirmOrderUseCase`, the
`INVENTORY_CONFIRM_GATEWAY` port + adapter). ADR-027 assigns full removal of the
confirm seam to the later inventory-reservation capability; this epic does not
touch the inventory microservice.

## README.md + CLAUDE.md updates

`README.md` (system diagram, API → Orders rewrite, new API → Cart section, a
Payment-gateway subsection, Roles update) and `CLAUDE.md` (retail microservice
section rewritten to host `cart/` + `orders/` + the `payment-gateway/` adapter
folder, the message-pattern list, the boundaries note) receive their **full pass
in task-09** (finalization), except the minimal dropped-route / dropped-RPC edits
task-01 must make in lockstep when it deletes `POST /api/order`,
`PUT /api/order/:id/confirm`, and the `retail.order.*` keys (so no deliverable
describes a route or key that no longer exists). The `spec/architecture-lint.spec.ts`
fixtures get their retail `cart/` + `orders/` (incl. the `payment-gateway`
infrastructure) bumpers in task-09; the generic `apps/*/src/modules/*/...` element
patterns in `eslint.config.mjs` classify the new module automatically, so **no
`eslint.config.mjs` change is expected**.

## Cleanup-first task

**task-01 is the cleanup-first task.** The retail order model is *replaced*, so
the obsolete artifacts are extensive: the `order` / `order_product` /
`order_status` / `order_product_status` tables (**4**, not 5 — the retail-side
`customer` table and `order.customer_id` were already dropped by the baseline
identity work; the surviving `customer` table is the gateway's auth aggregate and
is the **FK target to keep**); the retail `orders` domain / persistence /
use-cases / messaging / controller / pipe; the entire gateway `modules/retail/`
tree (`POST /api/order`, `PUT /api/order/:id/confirm`); the notification
`order-events.consumer.ts` + `SendOrderNotificationUseCase` (re-created in task-08
against the new event); the `libs/contracts/retail` legacy DTOs / events /
interfaces / enums; the six legacy `retail.order.*` routing keys; `scripts/seeds/
order.sql` + `order-product.sql`; and the order assertions in
`test/system-api.e2e-spec.ts` / `test/notification.e2e-spec.ts`. task-01
**deletes** every one of these (it never renames to `legacy`/`old`/`_v1`/`_bak`)
and fixes or deletes every dangling reference **in the same session**, leaving the
monorepo compiling, linting, and passing `unit` + `e2e` with a **bootable but
order-free** retail microservice (it boots on `retail_queue` with no message
handlers; `DatabaseModule.forRoot([])` registers no entities until task-02). The
epic's hint to leave "stub repositories" is **not** followed — a stub plus deleted
domain types would not compile; task-01 simply removes the whole legacy surface.

## Self-containment rule

No file under `docs/`, `apps/`, `libs/`, `http/`, `scripts/`, `spec/`,
`migrations/`, `README.md`, or `CLAUDE.md` may reference any path under `tmp/`,
or use the words "epic"/"task" as names for this planning process. Forward and
backward work is described by capability (e.g. "the inventory-reservation
capability", "a later idempotency-persistence capability", "the fulfillment
capability"), never by an epic/task number. Implementation docs are organised by
number + topic slug (`03-order-three-status-and-q4-decision.md`), never by an
epic/task breadcrumb.

## Cumulative exit criteria (gate for "all tasks complete")

- [ ] `yarn lint` passes (`--max-warnings 0`); the retail `cart/` + `orders/`
      module boundaries match the existing module shapes.
- [ ] `yarn test:unit` passes; **≥12 new** domain + use-case spec files green
      (`cart.model`, `cart-line.model`, `order.model`, `order-line.model`,
      `payment.model`, `address.model`, `fake-payment-gateway.adapter`, plus the
      `add-to-cart` / `remove-from-cart` / `change-cart-line-quantity` /
      `place-order` / `authorize-payment` / `capture-payment` / `get-order` /
      `list-my-orders` use-case specs).
- [ ] `yarn test:e2e` passes; `test/cart-to-order-walking-skeleton.e2e-spec.ts`,
      `test/guest-cart-promotion.e2e-spec.ts`, and
      `test/order-list-my-orders.e2e-spec.ts` are green.
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev` boots clean;
      all six tables (`cart`, `cart_line`, `order`, `order_line`, `address`,
      `payment`) present; the legacy 4 tables (`order_product`,
      `order_product_status`, `order_status`, plus the rebuilt `order`) reflect
      the new schema and the legacy lookup/junction tables are gone.
- [ ] Every request in `http/cart.http` and `http/order.http` executes
      end-to-end against the seeded customer + seeded variants.
- [ ] After Place Order, RabbitMQ shows `retail.order.placed` +
      `retail.payment.authorized`; the notification microservice logs an
      order-placed line (proves the consumer re-point worked).
- [ ] After Capture Payment, `retail.payment.captured` is published; the Payment
      row is `captured`; the Order's `paymentStatus = captured`.
- [ ] `OrderLine.sku`, `OrderLine.nameSnapshot`, `OrderLine.unitPriceMinor` are
      populated and match the catalog state at place-time.
- [ ] Per-topic docs `01 … 10` present under
      `docs/implementation/05-cart-order-payment-walking-skeleton/`; ADR-028 is
      recorded and ADR-013 is marked superseded.
- [ ] `README.md` System diagram + API (Cart, Orders, Payment gateway, Roles)
      sections rewritten; `CLAUDE.md` retail section + message-pattern list
      rewritten.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `scripts/`, `spec/`,
      `migrations/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`
      or uses the words "epic"/"task".
