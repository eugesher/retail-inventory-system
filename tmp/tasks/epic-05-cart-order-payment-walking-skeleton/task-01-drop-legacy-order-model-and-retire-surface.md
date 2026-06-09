---
epic: epic-05
task_number: 1
title: Tear down the legacy order model; retire its keys, contracts, consumer, seeds, routes
depends_on: []
doc_deliverable: docs/implementation/05-cart-order-payment-walking-skeleton/01-retail-rebuild-and-old-tables-dropped.md
adr_deliverable: docs/adr/028-cart-order-payment-and-address-chain.md
---

# Task 01 — Tear down the legacy order model; retire its keys, contracts, consumer, seeds, routes

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-013** (the `Order` aggregate + cross-service confirm flow you
are superseding — read it to know exactly what is being replaced), **ADR-024**
(RBAC v2 — customer tokens carry **no** `permissions` claim, so customer routes
are authorized by ownership, not a permission code; this is the basis for the
authorization decision recorded in ADR-028), **ADR-008** (dotted routing keys;
the legacy `MicroserviceMessagePatternEnum` must stay value-for-value with
`ROUTING_KEYS`, asserted by `routing-keys.constants.spec.ts`), **ADR-019**
(hand-authored migration with working `up`/`down`; `synchronize` stays off),
**ADR-003** (you are authoring **ADR-028** and flipping ADR-013's status),
**ADR-027** (the inventory `inventory.order.confirm` stub + the
`IProductStockOrderConfirmPayload` contract are a *kept* reserved surface — do
**not** delete them; you delete only the retail-side caller).

## Goal

Remove the entire legacy retail order model and its surface in one clean cut,
leaving the monorepo green (compiles, lints, unit + e2e pass) with a **bootable
but order-free** retail microservice. The `order` / `order_product` /
`order_status` / `order_product_status` tables are dropped; the retail `orders`
module, the gateway `retail` module, the notification order consumer, the
`libs/contracts/retail` legacy contracts, the six `retail.order.*` routing keys,
the two order seed files, and the order assertions in the e2e suite are all
deleted; and **ADR-028** is recorded (superseding **ADR-013**). The new Cart,
Order, Payment, and Address aggregates land in tasks 02–07; this task only tears
down and records the decision.

This is the **cleanup-first task**. Every obsolete artifact listed under *Files to
delete* is **removed outright** (never renamed to `legacy`/`old`/`_v1`/`_bak`),
and every dangling reference is fixed or deleted in this same session.

## Entry state assumed

- `epic-01` through `epic-04` are complete (baseline identity / RBAC v2, catalog,
  pricing, inventory `StockLevel`/`StockLocation`).
- The retail microservice runs the legacy `orders` module
  (`apps/retail-microservice/src/modules/orders/`): an `Order` aggregate that
  expands each line into one `OrderProduct` row per unit, two-value `OrderStatusVO`
  / `OrderProductStatusVO`, `order` / `order_product` entities + the
  `order_status` / `order_product_status` reference entities, `CreateOrderUseCase`
  / `ConfirmOrderUseCase` / `GetOrderUseCase`, an `OrderRabbitmqPublisher`
  (emits `retail.order.created` to `notification_events`), an
  `InventoryConfirmRabbitmqAdapter` (sends `inventory.order.confirm`), and an
  `OrderConfirmPipe`. `app.module.ts` imports `orderEntities` + `OrdersModule`.
- The gateway runs `apps/api-gateway/src/modules/retail/` exposing
  `POST /api/order` and `PUT /api/order/:id/confirm` (`OrderController`, gated
  `@Roles(RoleEnum.ADMIN)`), proxying `retail.order.create` / `.confirm` / `.get`.
- The notification microservice's `order-events.consumer.ts` subscribes to
  `retail.order.created` → `SendOrderNotificationUseCase`.
- The **retail-side `customer` table no longer exists** — the baseline identity
  work (`migrations/1779906269812-CreateCustomerTable.ts`) already dropped it
  *and* dropped the `order.customer_id` column + `FK_ORDER_CUSTOMER`. The surviving
  `customer` table is the gateway auth aggregate (`CHAR(36)` UUID PK), and it is the
  FK target the new `order` / `cart` tables will reference in later tasks — **do
  not drop it.** So this task drops **4** tables, not 5.
- `libs/contracts/retail/` holds `dto/` (`order-create.dto`,
  `order-create-response.dto`, `order-confirm-response.dto`), `enums/`
  (`order-status.enum` = `pending`/`confirmed`, `order-product-status.enum`),
  `events/` (`order-created`/`order-confirmed`/`order-cancelled`), `interfaces/`
  (`order-create`, `order-confirm`, `order-product-confirm`).
- `libs/messaging/routing-keys.constants.ts` holds `RETAIL_ORDER_CREATE`,
  `RETAIL_ORDER_CONFIRM`, `RETAIL_ORDER_GET`, `RETAIL_ORDER_CREATED`,
  `RETAIL_ORDER_CONFIRMED`, `RETAIL_ORDER_CANCELLED` (mirrored in
  `MicroserviceMessagePatternEnum`, asserted by
  `libs/messaging/spec/routing-keys.constants.spec.ts`).
- `scripts/utils/test-db-seed.util.ts` lists `'order.sql'` then `'order-product.sql'`
  first in `seedFiles`. `scripts/seeds/order.sql` + `order-product.sql` seed the
  legacy tables.
- `test/system-api.e2e-spec.ts` exercises `POST /api/order` (creates orders,
  asserts on `order` / `order_product` rows + Jest snapshots in
  `test/__snapshots__/system-api.e2e-spec.ts.snap`). `test/notification.e2e-spec.ts`
  publishes a synthetic `retail.order.created` and asserts the notifier fired.
  `test/auth.e2e-spec.ts` references the order endpoint(s) as protected-route
  samples.
- Latest migration: `migrations/1780860153719-ReplaceProductStockWithStockLevelAndLocation.ts`.
  The migration data-source globs `migrations/*{.ts,.js}`. Note its `down` recreates
  `product_stock` with an FK to `order_product` — your new migration is *newer*, so a
  full `migration:revert` runs your `down` first (recreating `order_product`) before
  that migration's `down`, keeping the FK valid.

## Scope

**In**
- One migration that drops `order_product`, `order_product_status`, `order`,
  `order_status` (in FK-safe order) with a working `up`/`down`.
- Delete the retail `orders` module entirely; reduce retail `app.module.ts` to a
  bootable, order-free service (`DatabaseModule.forRoot([])`, no business module).
- Delete the gateway `modules/retail/` tree and unregister it from the gateway
  `AppModule`.
- Delete the notification `order-events.consumer.ts` + `SendOrderNotificationUseCase`
  (+ their specs + barrel entries) and unregister them from the notification module.
- Gut `libs/contracts/retail/` of the legacy order DTOs / events / interfaces /
  enums (the package is repopulated with cart/order/payment/address contracts in
  later tasks).
- Retire the six `retail.order.*` routing keys from `ROUTING_KEYS` +
  `MicroserviceMessagePatternEnum`; update the routing-keys spec.
- Delete `scripts/seeds/order.sql` + `order-product.sql`; remove them from
  `seedFiles`.
- Trim/repoint the affected e2e specs so the suite is green with no order surface.
- Record **ADR-028**; flip ADR-013's status. Write doc `01`.

**Out**
- Any new aggregate — Cart (task-02), Order/OrderLine/Address (task-03), Payment
  (task-04), the operations (tasks 05–07), the notification re-point (task-08), the
  finalization (task-09).
- Touching the inventory microservice: the `inventory.order.confirm` stub +
  `IProductStockOrderConfirmPayload` contract are a *kept* reserved surface
  (ADR-027 owns their eventual removal). You delete only the retail-side caller.
- Adding the new `retail.cart.*` / `retail.order.placed` / `retail.payment.*` keys
  (tasks 02 / 06).

## Migration (`yarn migration:create`)

One migration, e.g. `…-DropLegacyOrderTables`, `synchronize` stays off:

```sql
-- up  (drop in FK-dependency order: order_product references order)
DROP TABLE IF EXISTS order_product;          -- one-row-per-unit line items
DROP TABLE IF EXISTS order_product_status;   -- reference lookup
DROP TABLE IF EXISTS `order`;                 -- reserved word — backtick it
DROP TABLE IF EXISTS order_status;            -- reference lookup
```

- `down` recreates the four tables with their original shapes + seed rows. Copy the
  `CREATE TABLE` bodies and the `INSERT INTO order_status` / `order_product_status` /
  reference rows verbatim from `migrations/1772600000000-InitStarterEntities.ts`
  (the `order` table there had a `customer_id` + `FK_ORDER_CUSTOMER`, but the
  baseline identity migration already dropped that column — recreate `order`
  **without** `customer_id` so `down` matches the schema as it actually was at the
  start of this task; document this in the migration comment). Recreate in
  dependency order: `order_status`, `order`, `order_product_status`, `order_product`
  (+ its FKs to `order` and `product` — note `product` is a stub the inventory work
  dropped, so re-add only the `FK_ORDER_PRODUCT_ORDER` FK, not `FK_ORDER_PRODUCT_PRODUCT`).
- Verify `yarn migration:run` then `yarn migration:revert` round-trips cleanly on
  top of the current schema.

## Controller / module reduction

- Delete `apps/retail-microservice/src/modules/orders/` in full (see *Files to
  delete*). Retail's `app.module.ts` keeps `ConfigModule`, `LoggerModule`, and
  `DatabaseModule.forRoot([])` (empty entity list — the cart entities arrive in
  task-02). The microservice still boots and listens on `retail_queue` with **no
  `@MessagePattern` / `@EventPattern` handlers** (the same "bootable, operation-free"
  shape the inventory service had after its model rebuild). Verify
  `yarn start:dev:retail-microservice` boots.
- Delete the gateway `modules/retail/` tree; remove `RetailModule` from
  `apps/api-gateway/src/app/app.module.ts` `imports[]` (and its import line). The
  gateway boots with no order/cart routes.
- Delete the notification `order-events.consumer.ts` + `SendOrderNotificationUseCase`
  (+ specs + `test-doubles` entries if order-specific) and remove them from
  `apps/notification-microservice/.../infrastructure/notifications.module.ts`
  (`controllers` / `providers`) and the `consumers` / `use-cases` barrels. The
  `inventory-events.consumer.ts` (low-stock) is **untouched**.

## libs/contracts/retail

Empty the package of legacy order contracts but keep it importable. After this
task, `libs/contracts/retail/index.ts` re-exports nothing order-shaped (later
tasks add cart/order/payment/address sub-areas). Delete the `dto/`, `events/`,
`interfaces/`, and `enums/` order files (see below). If leaving an empty package
trips a "module has no exports" lint/TS issue, leave a one-line placeholder
`export {};` in `index.ts` and remove it in task-02 when real exports return.

> Check the monorepo for **any** remaining importer of the deleted retail
> contracts (`OrderStatusEnum`, `OrderProductStatusEnum`, `OrderCreateDto`,
> `IRetailOrderCreatedEvent`, `IOrderCreatePayload`, `IOrderConfirm`, etc.) with
> `grep -rn` across `apps/`, `libs/`, `test/` and fix or delete each — the e2e
> specs below are the known ones.

## Routing keys

- `libs/messaging/routing-keys.constants.ts` — remove `RETAIL_ORDER_CREATE`,
  `RETAIL_ORDER_CONFIRM`, `RETAIL_ORDER_GET`, `RETAIL_ORDER_CREATED`,
  `RETAIL_ORDER_CONFIRMED`, `RETAIL_ORDER_CANCELLED`. Keep every `inventory.*` and
  `catalog.*` key.
- `libs/contracts/microservices/microservice-message-pattern.enum.ts` — remove the
  six matching `RETAIL_ORDER_*` members so the value-for-value agreement holds.
- `libs/messaging/spec/routing-keys.constants.spec.ts` — drop the removed keys from
  whatever exhaustive list it asserts.

## Files to add

- `migrations/<timestamp>-DropLegacyOrderTables.ts`
- `docs/adr/028-cart-order-payment-and-address-chain.md`
- `docs/implementation/05-cart-order-payment-walking-skeleton/01-retail-rebuild-and-old-tables-dropped.md`

## Files to modify

- `apps/retail-microservice/src/app/app.module.ts` — drop the `orderEntities` +
  `OrdersModule` imports; `DatabaseModule.forRoot([])`.
- `apps/api-gateway/src/app/app.module.ts` — remove the `RetailModule` import +
  its `imports[]` entry.
- `apps/notification-microservice/.../infrastructure/notifications.module.ts` —
  remove the `OrderEventsConsumer` controller + `SendOrderNotificationUseCase`
  provider; `apps/notification-microservice/.../infrastructure/consumers/index.ts`
  + `.../application/use-cases/index.ts` barrels.
- `libs/contracts/retail/index.ts` (+ `dto/index.ts`, `events/index.ts`,
  `interfaces/index.ts`, `enums/index.ts`) — drop the order exports.
- `libs/messaging/routing-keys.constants.ts` + `libs/messaging/spec/routing-keys.constants.spec.ts`.
- `libs/contracts/microservices/microservice-message-pattern.enum.ts`.
- `scripts/utils/test-db-seed.util.ts` — remove `'order.sql'` + `'order-product.sql'`
  from `seedFiles`.
- `test/system-api.e2e-spec.ts` — delete the `describe('Order', …)` block and its
  `getOrderRowsByOrderId` / `getOrderProductRowsByOrderId` data-source helpers +
  the `OrderStatusEnum` / `OrderProductStatusEnum` imports. If the spec is left with
  no assertions, deleting the whole spec (+ its `.snap`) is acceptable — record the
  choice in the carryover. Remove `test/__snapshots__/system-api.e2e-spec.ts.snap`
  order entries (or the file if the spec is deleted).
- `test/notification.e2e-spec.ts` — it asserts on a synthetic `retail.order.created`.
  Since that key + `IRetailOrderCreatedEvent` are gone, **delete this spec for now**;
  task-08 re-creates the notification e2e against `retail.order.placed`. (Record the
  deletion in the carryover so task-08 knows to re-add it.)
- `test/auth.e2e-spec.ts` — repoint any `/api/order` protected-route reference to a
  still-existing protected route (recommended `GET /api/inventory/locations`,
  `inventory:read`-gated, or `GET /api/auth/me`), preserving the
  401-without-token / 200-with-token assertions.
- `test/data-source/*` — delete the now-unused order row-reader helpers.
- `CLAUDE.md` / `README.md` — only the lines naming the now-deleted
  `POST /api/order`, `PUT /api/order/:id/confirm` routes and the `retail.order.*`
  keys (so no deliverable describes a route/key that no longer exists). The full
  retail rewrite of these files is task-09; keep this edit minimal.

## Files to delete

- The entire `apps/retail-microservice/src/modules/orders/` tree, including:
  `domain/order.model.ts`, `domain/order-product.model.ts`,
  `domain/order-status.value-object.ts`, `domain/order-product-status.value-object.ts`,
  `domain/events/*` (`order-created`/`order-confirmed`/`order-cancelled` + index),
  `domain/index.ts`, `domain/spec/*`; `application/ports/*`
  (`order.repository.port`, `order-events.publisher.port`, `inventory-confirm.gateway.port`,
  index); `application/use-cases/*` (`create-order`, `confirm-order`, `get-order`,
  index, `spec/*`); `infrastructure/orders.module.ts`,
  `infrastructure/messaging/*` (`order-rabbitmq.publisher`,
  `inventory-confirm.rabbitmq.adapter`, index), `infrastructure/persistence/*`
  (`order.entity`, `order-product.entity`, `order-status.entity`,
  `order-product-status.entity`, mappers, `order-typeorm.repository`, `index`,
  `spec/*`); `presentation/orders.controller.ts`, `presentation/pipes/*`;
  `modules/orders/index.ts`.
- The entire gateway `apps/api-gateway/src/modules/retail/` tree
  (`application/ports/*`, `application/use-cases/*`,
  `infrastructure/messaging/retail-rabbitmq.adapter.ts`,
  `presentation/order.controller.ts`, `presentation/pipes/*`, `retail.module.ts`,
  `index.ts`).
- `apps/notification-microservice/.../infrastructure/consumers/order-events.consumer.ts`;
  `.../application/use-cases/send-order-notification.use-case.ts` +
  `.../application/use-cases/spec/send-order-notification.use-case.spec.ts`.
- `libs/contracts/retail/dto/order-create.dto.ts`,
  `dto/order-create-response.dto.ts`, `dto/order-confirm-response.dto.ts`;
  `events/order-created.event.ts`, `events/order-confirmed.event.ts`,
  `events/order-cancelled.event.ts`; `interfaces/order-create.interface.ts`,
  `interfaces/order-confirm.interface.ts`, `interfaces/order-product-confirm.interface.ts`;
  `enums/order-status.enum.ts`, `enums/order-product-status.enum.ts`.
- `scripts/seeds/order.sql`, `scripts/seeds/order-product.sql`.

> Do **not** delete: the inventory `inventory.order.confirm` stub +
> `INVENTORY_ORDER_CONFIRM` routing key + the `IProductStockOrderConfirmPayload`
> contract (kept reserved surface, ADR-027); any `inventory.*` / `catalog.*`
> routing key; the gateway `customer` table / auth `Customer` aggregate; the
> notification `inventory-events.consumer.ts` (low-stock).

## Tests

- **Unit** (`yarn test:unit`): the deleted use-case / domain / mapper specs go with
  their sources. The routing-keys spec stays green after the six keys are removed.
  No new unit specs in this task.
- **Migration**: `yarn migration:run` applies the drop on top of the current schema;
  `SHOW TABLES` confirms `order`, `order_product`, `order_status`,
  `order_product_status` are gone; `yarn migration:revert` recreates them cleanly
  and re-running `migration:run` drops them again.
- **E2E** (`yarn test:e2e`): the trimmed `system-api` (or its deletion), the deleted
  `notification` spec, and the repointed `auth` spec, plus all catalog / inventory /
  pricing / auth / iam specs, pass with retail offering no order surface and the
  gateway offering no order routes.
- **Seed**: `yarn test:seed` runs without `order.sql` / `order-product.sql` and does
  not error (no legacy order tables remain).

## Doc deliverable

`docs/implementation/05-cart-order-payment-walking-skeleton/01-retail-rebuild-and-old-tables-dropped.md`
— what was deleted (the `order`/`order_product`/`order_status`/`order_product_status`
tables; the one-row-per-unit `OrderProduct` model; the two-value status; the
cross-service confirm→reserve RPC caller; the `retail.order.*` keys; the legacy
retail contracts; the order seeds) and **why a full rewrite is cheaper than an
incremental refactor** (the new model is a structurally different shape — distinct
Cart/Order aggregates, three orthogonal statuses, money-minor line snapshots,
Payment + Address — so an in-place migration would carry more risk than a clean
cut on a system with no production data). State that the surviving `customer` table
is the gateway auth aggregate (the FK target for the rebuilt order/cart), not a
retail table. Cross-link `docs/adr/028-…md` and `docs/adr/013-…md` by relative
path. Describe everything by capability — never by an epic/task number.

## ADR deliverable

`docs/adr/028-cart-order-payment-and-address-chain.md` (Nygard hybrid: Status,
Context, Decision, Alternatives Considered, Consequences; 3-digit padded; allocate
the number at first commit — if `028` is taken, take the next free number and
record it in the carryover). Decision content:
- The retail microservice hosts **two aggregates in one bounded context's two
  modules**: a mutable `Cart` (with `CartLine`) and an immutable `Order` (with
  `OrderLine`), with **one-shot conversion at place-time** (Q3) — a placed order is
  an immutable snapshot no later cart edit can corrupt.
- `Order` carries **three orthogonal status fields** — `status`
  (pending/confirmed/cancelled/shipped/delivered), `paymentStatus`
  (none/authorized/captured/refunded/failed), `fulfillmentStatus`
  (unfulfilled/partially-shipped/shipped/delivered) (Q4) — so payment and
  fulfillment evolve independently of the order lifecycle.
- **Authorize on place, capture explicit** (Q5): Place Order auto-authorizes via
  the `PAYMENT_GATEWAY` port inline; Capture is a separate operation. Ship-triggered
  auto-capture is a later fulfillment capability.
- A **`PAYMENT_GATEWAY` port + `FakePaymentGatewayAdapter`** (always-authorize)
  default seam, so a real gateway swaps in later without touching use cases. The
  `Payment` aggregate + port + adapter live **inside the `orders/` module** (Payment
  is part of the order/checkout context; its operations touch the `Order`
  aggregate) — *not* a standalone `payment/` module, a deliberate simplification of
  the epic's looser wording that avoids cross-module domain coupling.
- A **polymorphic `Address`** (`ownerType ∈ {customer, order}`), **snapshotted**
  onto each placed order — an order's billing/shipping address rows are immutable
  copies, not references to a customer address book (which is a later capability).
- **`version` OCC columns** ship on `cart` + `order` now though no concurrency
  guard consumes them yet (retrofitting onto a populated table later is a
  destructive `ALTER TABLE`); the `Idempotency-Key` header is accepted on Place /
  Capture now though **dedupe enforcement is deferred** to a later
  idempotency-persistence capability (Q10). Repeat-place idempotency in this epic
  is driven by **cart state** (a placed cart is `converted`; re-placing it returns
  the order it converted into).
- **Customer self-service authorization = authenticated + ownership check at the
  use case** — *not* a customer permission code. ADR-024 fixes that customer tokens
  carry no `permissions` claim, so a `@RequiresPermission('customer:own-orders:read')`
  gate would reject the very customers it targets. Instead, customer cart/order
  routes require a valid bearer and the use case compares the principal id to the
  resource's `customerId`; `order:read` (existing) and `order:capture` (new, added
  in the read/capture task) are the **staff overrides**. This **upholds ADR-024**
  and explicitly *declines* to add a customer permission code.
- The cross-service **confirm flow is retired on the retail side** (the
  `INVENTORY_CONFIRM_GATEWAY` port + `ConfirmOrderUseCase` are deleted). The
  inventory `inventory.order.confirm` stub + `IProductStockOrderConfirmPayload`
  contract remain a reserved surface (ADR-027) until the inventory-reservation
  capability removes them.
- The six `retail.order.*` legacy keys are retired and replaced by
  `retail.cart.*` / `retail.order.placed` / `retail.payment.*` (added in later
  tasks).
- **Supersedes ADR-013** (`Order` aggregate + cross-service confirm): in ADR-013,
  flip `Status` to `Superseded by ADR-028` + add a one-line pointer (the only edit
  an accepted ADR may receive — ADR-003).
- Alternatives: a single mutable Order edited in place (rejected — corrupts the
  immutable record, Q3); one combined status field (rejected — payment ≠
  fulfillment ≠ lifecycle, Q4); a standalone `payment/` module (rejected —
  cross-module domain coupling to `Order`); a customer permission claim to gate
  customer routes (rejected — contradicts ADR-024; ownership checks are the model);
  an incremental in-place schema refactor (rejected — different shape, no prod data).

## Carryover to read

None — first task.

## Carryover to produce

Write `tmp/tasks/epic-05-cart-order-payment-walking-skeleton/carryover-01.md` per
`tmp/tasks/execution-requirements.md` §7. Capture at minimum:
- **Entry state for task-02:** the four legacy order tables are dropped; the retail
  microservice boots order-free (`DatabaseModule.forRoot([])`, no handlers); the
  gateway has no retail/order module; the notification order consumer + use case are
  deleted; `libs/contracts/retail` is empty of order contracts; the six
  `retail.order.*` keys are retired; the surviving `customer` table (gateway auth,
  CHAR(36) UUID) is the FK target for the new `order`/`cart`.
- **Files added / modified / deleted** (concise list).
- **Key decisions:** the ADR number actually allocated for ADR-028; that ADR-013 is
  marked superseded; that Payment lives inside the `orders/` module (not a separate
  `payment/` module); that customer routes will be owner-checked (no
  `customer:own-orders:read` code); whether `system-api.e2e` was trimmed or deleted;
  that `notification.e2e` was deleted (task-08 re-adds it); where `auth.e2e` was
  repointed.
- **Known gaps / deferrals:** Cart foundation → task-02; Order/OrderLine/Address
  foundation → task-03; Payment + port → task-04; cart operations + guest promotion
  → task-05; Place Order + authorize + events → task-06; Capture + Get + List +
  `order:capture` + seed → task-07; notification re-point → task-08; README/CLAUDE +
  lint fixtures + http docs → task-09. The inventory confirm seam removal is owned
  by the inventory-reservation capability (not this epic).
- **How to verify:** `yarn lint`, `yarn test:unit`, `yarn test:e2e`, `yarn build`,
  `yarn migration:run` + `yarn migration:revert`, the self-containment grep, and
  `docker compose up -d && yarn migration:run && yarn start:dev` boots retail
  order-free.

## Exit criteria

- [ ] `order`, `order_product`, `order_status`, `order_product_status` are dropped;
      the migration reverts cleanly (recreating them) and re-applies.
- [ ] The retail microservice boots and listens on `retail_queue` with no message
      handlers; the gateway boots with no order/cart routes; the notification
      service boots with only the inventory (low-stock) consumer.
- [ ] No dangling import to any deleted symbol (`OrderStatusEnum`, `OrderCreateDto`,
      `IRetailOrderCreatedEvent`, the deleted ports/use-cases/keys, …) remains
      anywhere in `apps/` / `libs/` / `test/`; nothing was renamed to
      `legacy`/`old`/`_v1`.
- [ ] The inventory `inventory.order.confirm` stub + `IProductStockOrderConfirmPayload`
      + the `customer` table are untouched.
- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes.
- [ ] `yarn test:e2e` passes (trimmed/deleted `system-api`, deleted `notification`,
      repointed `auth`; catalog/inventory/pricing/auth/iam specs green).
- [ ] ADR-028 is recorded; ADR-013 is marked `Superseded by ADR-028`; doc `01` is
      written.
- [ ] The self-containment grep is clean
      (`grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`).
- [ ] `carryover-01.md` is written.
