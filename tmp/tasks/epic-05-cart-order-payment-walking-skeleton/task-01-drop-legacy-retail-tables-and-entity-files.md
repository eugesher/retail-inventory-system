---
epic: epic-05
task_number: 1
title: Drop legacy retail tables + entity files; park `OrderTypeormRepository` in a throwing-stub state
depends_on: []
doc_deliverable: docs/implementation/05-cart-order-payment-walking-skeleton/01-retail-rebuild-and-old-tables-dropped.md
---

# Task 01 — Drop legacy retail tables + entity files

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** For any decision relevant to this task, open the linked original ADR under `docs/adr/` before implementing. Especially relevant here: [ADR-013](../../docs/adr/013-order-aggregate-and-cross-service-confirm.md) (the legacy Order aggregate being demolished), [ADR-019](../../docs/adr/019-typeorm-and-mysql-for-persistence.md) (forward-only migration policy), [ADR-008](../../docs/adr/008-rabbitmq-via-libs-messaging.md) (the routing keys being retired), and [ADR-004](../../docs/adr/004-adopt-hexagonal-architecture-per-service.md) (the per-module hexagonal shape the rewrite preserves).

## Goal

Remove the entire ledger-of-states schema from the retail microservice: drop the five MySQL tables (`order`, `order_product`, `order_status`, `order_product_status`, `customer`), delete the matching TypeORM entity files plus the orphaned mappers, and **rewrite `OrderTypeormRepository` into a method-by-method throwing stub** so the build keeps compiling while tasks 02–08 reassemble the real implementation behind it. Delete the legacy domain models (`order.model.ts`, `order-product.model.ts`, `order-status.model.ts`, `order-product-status.model.ts`, `customer-ref.model.ts` / `customer.model.ts`, the legacy events under `domain/events/`); replacements land aggregate-by-aggregate in tasks 02–04 with substantially different shapes (the new `Order` is an immutable aggregate that snapshots line data, three orthogonal status fields, a polymorphic `Address` snapshot — see `epic-05` "Architectural Decisions Honored").

This task ships a **deliberately broken intermediate state**. Between this task and task-08, the retail microservice will not be able to satisfy any of the legacy RPCs (`retail.order.create`, `retail.order.confirm`, `retail.order.get`); this task already deletes their `@MessagePattern` handlers along with the use cases that backed them (`create-order.use-case.ts`, `confirm-order.use-case.ts`, `get-order.use-case.ts`). The throwing-stub state on the repository is intentional, not accidental — the DI graph still resolves, but any code path that wires up to it during this window receives a deterministic "removed in epic-05 task-N" error frame rather than a `TypeError` from a half-deleted symbol.

The legacy outbound publisher (`OrderRabbitmqPublisher` — emits `retail.order.created`/`retail.order.confirmed`) is **deleted in this task**. Its emit-side counterparts on the new routing keys (`retail.order.placed`, `retail.payment.authorized`, `retail.payment.captured`, `retail.cart.*`) land in task-06 / task-07. The notification-microservice consumer subscribed to the old key (`retail.order.created`) keeps working in the cluster only because no producer remains; task-11 re-points it to `retail.order.placed` so the chain is unbroken once task-06 ships the new producer.

## Entry state assumed

Epic-04 is complete on disk. Specifically:

- `apps/retail-microservice/src/modules/orders/` is the existing hexagonal layout (ADR-013) carrying the legacy entity files and the three legacy use cases.
- `apps/api-gateway/src/modules/retail/` still has `OrderController` (with `POST /api/order` and `PUT /api/order/:id/confirm`) and the `RetailRabbitmqAdapter` mapping to `RETAIL_ORDER_CREATE` / `RETAIL_ORDER_CONFIRM`. **No changes here in this task** — task-09 reshapes the api-gateway side.
- `libs/messaging/routing-keys.constants.ts` still lists `RETAIL_ORDER_CREATE`, `RETAIL_ORDER_CONFIRM`, `RETAIL_ORDER_GET`, `RETAIL_ORDER_CREATED`, `RETAIL_ORDER_CONFIRMED`, `RETAIL_ORDER_CANCELLED`. This task retires the first three (the RPCs) by removing both the gateway-side message-pattern handlers and the constants themselves. The three event constants stay through this task — task-06 retires `RETAIL_ORDER_CREATED` and `RETAIL_ORDER_CONFIRMED` once the new `RETAIL_ORDER_PLACED` constant lands.
- `libs/contracts/retail/` carries the legacy DTOs (`CreateOrderRequestDto`, `ConfirmOrderRequestDto`, `OrderResponseDto`, etc.) and the legacy `IOrderCreatedEvent` / `IOrderConfirmedEvent`. **None of these are deleted in this task** — tasks 02–08 carve out the new shapes alongside, and task-12 does the final cleanup pass on the legacy contracts. This keeps the gateway-side compile clean through this task.
- `apps/notification-microservice/.../infrastructure/consumers/order-events.consumer.ts` is subscribed to `retail.order.created` and uses `IOrderCreatedEvent`. **Untouched here** — task-11 re-points it to `retail.order.placed`.

## Scope

**In:**

- A new migration `migrations/<timestamp>-DropLegacyRetailTables.ts` that drops `order`, `order_product`, `order_status`, `order_product_status`, and `customer` tables. Idempotent — uses `DROP TABLE IF EXISTS` so a half-rolled-back environment can still run it. Order of drops matters because of FKs: drop `order_product_status` first, then `order_product`, then `order_status`, then `order`, then `customer` (the FK `order.customer_id → customer.id` requires `order` to be gone before `customer` can drop). Use `qr.query('SET FOREIGN_KEY_CHECKS = 0')` as a defensive opener and reset to 1 at the end; the project's existing migrations have a precedent for this pattern.
- Delete legacy entity files under `apps/retail-microservice/src/modules/orders/infrastructure/persistence/`:
  - `order.entity.ts`
  - `order-product.entity.ts`
  - `order-status.entity.ts`
  - `order-product-status.entity.ts`
  - `customer.entity.ts`
- Delete the now-orphaned mappers in the same folder:
  - `order.mapper.ts`
  - `order-product.mapper.ts`
  - `customer.mapper.ts`
- Delete the legacy domain models under `apps/retail-microservice/src/modules/orders/domain/`:
  - `order.model.ts`
  - `order-product.model.ts`
  - `order-status.model.ts`
  - `order-product-status.model.ts`
  - `customer-ref.model.ts` (the VO referencing the customer's id)
  - `domain/events/order-created.event.ts`
  - `domain/events/order-confirmed.event.ts`
  - `domain/events/order-cancelled.event.ts`
- Delete the legacy domain specs under `apps/retail-microservice/src/modules/orders/domain/spec/`:
  - `order.model.spec.ts`
  - `order-product.model.spec.ts`
  - `order-status.model.spec.ts`
  - `customer-ref.model.spec.ts`
- Delete the legacy use cases + their specs under `apps/retail-microservice/src/modules/orders/application/use-cases/`:
  - `create-order.use-case.ts` + `spec/create-order.use-case.spec.ts`
  - `confirm-order.use-case.ts` + `spec/confirm-order.use-case.spec.ts`
  - `get-order.use-case.ts` + `spec/get-order.use-case.spec.ts`
- Delete the legacy outbound publisher and its spec under `apps/retail-microservice/src/modules/orders/infrastructure/messaging/`:
  - `order-rabbitmq.publisher.ts`
  - `inventory-confirm-rabbitmq.adapter.ts` (the RPC adapter to `inventory.order.confirm` — that routing key is reshaped by epic-04 task-08 and is no longer reachable from retail in the walking-skeleton chain; task-06 wires the new `PAYMENT_GATEWAY` port for the place-order flow instead)
  - their specs under `spec/`
- Delete the legacy ports + their DI symbols under `apps/retail-microservice/src/modules/orders/application/ports/`:
  - `order.repository.port.ts` keeps its **file** (the symbol `ORDER_REPOSITORY` survives) but the **interface** is reshaped in task-03 (different method set). For this task: shrink the interface body to a marker comment and leave only the `ORDER_REPOSITORY` symbol export so DI continues to resolve through the throwing stub. Task-03 fleshes the interface out against the new aggregate.
  - `order-events-publisher.port.ts` deleted entirely; replaced in task-06 by the new emit-side publisher.
  - `inventory-confirm-gateway.port.ts` deleted entirely; the new `PAYMENT_GATEWAY` port (task-04) supersedes the cross-service seam role.
- Rewrite `apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-typeorm.repository.ts` into a **throwing stub** with the same idiom epic-04 task-01 introduced. The class still has the `@Injectable()` decorator and still binds to `ORDER_REPOSITORY` in `orders.module.ts`, but every public method throws a single sentinel error `RetailRepositoryStubError(method, taskNumber)` whose constructor argument names the task that fills the method in. Concrete shape under §"Throwing-stub shape" below.
- Rewrite the controller `apps/retail-microservice/src/modules/orders/presentation/orders.controller.ts`: delete every `@MessagePattern` handler (`RETAIL_ORDER_CREATE`, `RETAIL_ORDER_CONFIRM`, `RETAIL_ORDER_GET`) and their pipes (`OrderCreatePipe`, `OrderConfirmPipe` under `presentation/pipes/` — delete both files). Keep the controller class as an empty shell decorated with `@Controller()` so the DI graph keeps resolving; tasks 05–08 add handlers back one by one. Alternatively, delete the controller entirely and rely on task-05's new `cart.controller.ts` + task-08's new `orders.controller.ts` — pick the path that produces the cleanest intermediate (the empty-shell approach is preferred so the import path to `orders.controller.ts` stays stable; the file is shorter than its pipes folder).
- Update `apps/retail-microservice/src/modules/orders/infrastructure/orders.module.ts`:
  - `DatabaseModule.forFeature([Order, OrderProduct, OrderStatus, OrderProductStatus, Customer])` shrinks to `DatabaseModule.forFeature([])`.
  - Provider list drops `CreateOrderUseCase`, `ConfirmOrderUseCase`, `GetOrderUseCase`, `OrderRabbitmqPublisher`, `InventoryConfirmRabbitmqAdapter` and their bindings. Keep the `OrderTypeormRepository` provider so the throwing stub is still bound.
  - Imports drop `MicroserviceClientInventoryModule` (it was wiring the legacy `inventory.order.confirm` adapter).
- Update `apps/retail-microservice/src/modules/orders/infrastructure/persistence/index.ts` to remove the deleted entity exports.
- Update `apps/retail-microservice/src/modules/orders/domain/index.ts` to remove the deleted domain exports.
- Update `apps/retail-microservice/src/modules/orders/application/ports/index.ts` to remove the deleted port exports; keep the `ORDER_REPOSITORY` symbol export.
- Update `apps/retail-microservice/src/modules/orders/application/use-cases/index.ts` to remove the three legacy use-case exports.
- Update `libs/messaging/routing-keys.constants.ts`: remove `RETAIL_ORDER_CREATE`, `RETAIL_ORDER_CONFIRM`, `RETAIL_ORDER_GET`. Keep the three event constants (`RETAIL_ORDER_CREATED`, `RETAIL_ORDER_CONFIRMED`, `RETAIL_ORDER_CANCELLED`) — they are retired in task-06 once the new constants land.
- Update the `routing-keys.constants.spec.ts` (which asserts the legacy `MicroserviceMessagePatternEnum` agrees value-for-value) to drop the three removed entries from both sides (the enum is in `libs/contracts/microservices/` — remove the matching entries there too).
- Update `apps/api-gateway/src/modules/retail/` so the gateway still compiles. **This task does not reshape the gateway** — task-09 owns that. But the deletion of the three RPC routing keys forces a temporary measure: the gateway's `RetailRabbitmqAdapter` references the constants by name (`ROUTING_KEYS.RETAIL_ORDER_CREATE` etc.). The minimum-change path is to mark the controllers' usages with a temporary `@deprecated` JSDoc + replace the constant references with inline string literals `'retail.order.create'` etc., with a `// TODO(epic-05 task-09): remove with the controller rewrite`. The deprecation note in the JSDoc cites the task number. The HTTP endpoints will return RMQ errors at runtime — that is the expected observable behavior in this transition window, identical in spirit to the inventory-side throwing-stub from epic-04 task-01.
- Doc deliverable `01-retail-rebuild-and-old-tables-dropped.md` under `docs/implementation/05-cart-order-payment-walking-skeleton/` — the introductory half. Task-12 appends the cumulative "after" snapshot once the new schema is fully in place.

**Out:**

- Adding the new entities — tasks 02–04.
- Rewriting the api-gateway controller surface — task-09.
- The full retirement of the legacy event constants (`RETAIL_ORDER_CREATED`, `RETAIL_ORDER_CONFIRMED`) — task-06 owns that when the new producer is wired.
- Re-pointing the notification consumer — task-11.
- Deleting legacy DTOs in `libs/contracts/retail/` — task-12.

## Throwing-stub shape for `OrderTypeormRepository`

The file is rewritten end-to-end. The class still implements the (now-shrunk) `IOrderRepositoryPort` interface so DI wiring keeps compiling, but every method body throws. The sentinel error class lives next to the stub. Concrete shape:

```ts
import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import type { IOrderRepositoryPort } from '../../application/ports';

// Sentinel error class so runtime failures during the epic-05 transition
// window are self-describing in logs. Removed when task-08's `GetOrderUseCase`
// + task-06's `PlaceOrderUseCase` land and the real methods take over.
export class RetailRepositoryStubError extends Error {
  constructor(method: string, taskNumber: number) {
    super(
      `OrderTypeormRepository.${method} is unavailable: the underlying ` +
        `tables (order, order_product, order_status, order_product_status, customer) ` +
        `were dropped by epic-05 task-01. The real implementation lands in ` +
        `epic-05 task-${taskNumber}. If you are reading this, an old caller ` +
        `was not removed in lockstep.`,
    );
    this.name = 'RetailRepositoryStubError';
  }
}

@Injectable()
export class OrderTypeormRepository implements IOrderRepositoryPort {
  constructor(
    @InjectPinoLogger(OrderTypeormRepository.name)
    private readonly logger: PinoLogger,
  ) {}

  // The interface in this task is a single-method marker (see ports/index.ts).
  // Task-03 reshapes it to the real surface (save / findById / listByCustomer).
  // The stub method names below mirror the planned real shape so a runtime hit
  // produces a self-describing trace.
  public save(_order: unknown): Promise<never> {
    throw new RetailRepositoryStubError('save', 3);
  }
  public findById(_id: number): Promise<never> {
    throw new RetailRepositoryStubError('findById', 8);
  }
  public listByCustomer(
    _customerId: string,
    _page: unknown,
  ): Promise<never> {
    throw new RetailRepositoryStubError('listByCustomer', 8);
  }
}
```

Notes for the implementer:

- The per-method `taskNumber` argument tells readers of a runtime stack trace exactly which task fills in the gap. Task-03 fills `save` + `findById` (the persistence half); task-08 fills `listByCustomer` (the list-my-orders read).
- `BaseTypeormRepository` is no longer extended. The constructor is intentionally bare apart from the logger injection.
- The legacy `pullDomainEvents()`-then-publish step inside `save()` was a behavior of the previous repository; it does not survive — task-06 (`PlaceOrderUseCase`) wires emission through the new publisher port, not the repository.

## `apps/retail-microservice/src/modules/orders/application/use-cases/spec/test-doubles.ts`

This file (or its equivalent in the existing layout — verify against the current tree before deleting) holds in-memory port doubles consumed by the legacy use case specs. **Delete it** alongside the legacy specs. Tasks 05–08 each ship their own test-doubles file or rely on `jest.Mocked<>` per-spec; the legacy file's shapes do not survive the aggregate rewrite.

## Files to add

- `migrations/<timestamp>-DropLegacyRetailTables.ts` — the migration described above. Use `Date.now()` for the timestamp prefix per project convention; the `migrations/` folder ordering will surface the right name when `yarn migration:create -- DropLegacyRetailTables` is run.
- `docs/implementation/05-cart-order-payment-walking-skeleton/01-retail-rebuild-and-old-tables-dropped.md` — introductory half; task-12 appends the post-state snapshot.

## Files to modify

- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-typeorm.repository.ts` — rewritten end-to-end into the throwing stub.
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/index.ts` — drop the deleted-entity exports; keep the repository export.
- `apps/retail-microservice/src/modules/orders/infrastructure/orders.module.ts` — provider/imports/forFeature shrinkage described above.
- `apps/retail-microservice/src/modules/orders/domain/index.ts` — drop the deleted domain exports.
- `apps/retail-microservice/src/modules/orders/application/ports/index.ts` — drop the deleted port exports; keep `ORDER_REPOSITORY`.
- `apps/retail-microservice/src/modules/orders/application/ports/order.repository.port.ts` — shrink to a marker (the interface gets its real shape in task-03).
- `apps/retail-microservice/src/modules/orders/application/use-cases/index.ts` — drop legacy use-case exports.
- `apps/retail-microservice/src/modules/orders/presentation/orders.controller.ts` — empty-shell controller with no `@MessagePattern` handlers.
- `libs/messaging/routing-keys.constants.ts` — remove the three RPC constants.
- `libs/messaging/routing-keys.constants.spec.ts` — remove the three RPC assertions.
- `libs/contracts/microservices/microservice-message-pattern.enum.ts` (or similar — confirm the file name from the current tree) — remove the matching three enum entries.
- `apps/api-gateway/src/modules/retail/infrastructure/messaging/retail-rabbitmq.adapter.ts` — replace the deleted `ROUTING_KEYS.RETAIL_ORDER_*` references with inline string literals + a TODO comment citing task-09.

## Files to delete

- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/order.entity.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-product.entity.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-status.entity.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-product-status.entity.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/customer.entity.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/order.mapper.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-product.mapper.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/persistence/customer.mapper.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/messaging/order-rabbitmq.publisher.ts` + `spec/order-rabbitmq.publisher.spec.ts`
- `apps/retail-microservice/src/modules/orders/infrastructure/messaging/inventory-confirm-rabbitmq.adapter.ts` + `spec/inventory-confirm-rabbitmq.adapter.spec.ts`
- `apps/retail-microservice/src/modules/orders/domain/order.model.ts`, `order-product.model.ts`, `order-status.model.ts`, `order-product-status.model.ts`, `customer-ref.model.ts`
- `apps/retail-microservice/src/modules/orders/domain/spec/order.model.spec.ts`, `order-product.model.spec.ts`, `order-status.model.spec.ts`, `customer-ref.model.spec.ts`
- `apps/retail-microservice/src/modules/orders/domain/events/order-created.event.ts`, `order-confirmed.event.ts`, `order-cancelled.event.ts`
- `apps/retail-microservice/src/modules/orders/application/use-cases/create-order.use-case.ts` + spec
- `apps/retail-microservice/src/modules/orders/application/use-cases/confirm-order.use-case.ts` + spec
- `apps/retail-microservice/src/modules/orders/application/use-cases/get-order.use-case.ts` + spec
- `apps/retail-microservice/src/modules/orders/application/use-cases/spec/test-doubles.ts`
- `apps/retail-microservice/src/modules/orders/application/ports/order-events-publisher.port.ts`
- `apps/retail-microservice/src/modules/orders/application/ports/inventory-confirm-gateway.port.ts`
- `apps/retail-microservice/src/modules/orders/presentation/pipes/order-create.pipe.ts`
- `apps/retail-microservice/src/modules/orders/presentation/pipes/order-confirm.pipe.ts`

## Tests

- The deleted spec count is ≥9 (the three use-case specs + four domain specs + two messaging-adapter specs). No new specs are added in this task.
- `yarn build:retail-microservice` must succeed — the throwing stub still satisfies the (single-method-marker) `IOrderRepositoryPort`.
- `yarn build` (the full monorepo build) must succeed — the gateway adapter compiles against the inline-literal routing keys.
- `yarn lint` must pass; the inline literal in the gateway adapter is allowed temporarily because the per-layer rule does not ban string literals at the gateway adapter layer; the TODO comment justifies the temporary exception.
- The boot smoke test must succeed: `docker compose up -d mysql rabbitmq redis && yarn migration:run && yarn start:dev:retail-microservice`. The service starts; any `retail.order.*` RPC call still fails with a RMQ-level handler-not-found (the controller has no handlers) until task-05's cart handlers and task-08's order handlers land. This is the desired observable behavior during this transition.

## Doc deliverable

Write `docs/implementation/05-cart-order-payment-walking-skeleton/01-retail-rebuild-and-old-tables-dropped.md` (introductory half — target ~130 lines now; task-12 appends ~40 more lines for the after-snapshot). Sections this task writes:

1. **Why a full rewrite is cheaper than incremental refactor.** Restate the epic's "Goal": the legacy `Order` aggregate carried two tables for status (`order_status` + `order_product_status`) — a normalized state-machine table that proved redundant once Q4's three-status-fields-on-the-row decision landed. The polymorphic `Address` snapshot is incompatible with the legacy `customer` table's address columns (the old table embedded a single address; the new model snapshots two addresses per order). The cart/order split (Q3) had no equivalent at all in the legacy schema. Across these three changes, an aggregate-by-aggregate refactor would have left two breaking intermediate snapshots — easier to detonate and rebuild.
2. **What got dropped.** Bullet list with the five tables + the entity files + the mappers + the legacy events + the legacy use cases + the legacy publisher + the legacy `InventoryConfirmRabbitmqAdapter`. Cite each file by path and explain the role it played pre-deletion (e.g. `customer.entity.ts` was the retail-side mirror of identity from the early-days monolith; `epic-01`'s default-b decision moved identity authoritatively to the api-gateway auth module).
3. **The retired RPC routing keys.** `retail.order.create` / `retail.order.confirm` / `retail.order.get` — three constants removed in this task. The matching enum entries in `MicroserviceMessagePatternEnum` go with them. The three event constants (`retail.order.created` / `retail.order.confirmed` / `retail.order.cancelled`) survive this task and are retired by task-06 when the new producer ships.
4. **The forward-only `down()` no-op.** Cite `CLAUDE.md` §"Migrations". A rollback past this migration would require schemas the entity files no longer carry. The project's deploy policy is forward-only.
5. **The throwing-stub interlude.** Why `OrderTypeormRepository` is not deleted outright. (Answer: the DI graph references it through `ORDER_REPOSITORY`, and tasks 02–08 will rebuild it incrementally; tearing out the binding now and then re-adding it would force `orders.module.ts` to be modified four times instead of twice.) Cite the per-method `taskNumber` argument and what runtime behavior to expect.
6. **The gateway adapter's inline-literal workaround.** A brief paragraph: the `RetailRabbitmqAdapter` in the gateway still wires to `'retail.order.create'` and `'retail.order.confirm'` for the duration of the task-01 → task-09 window. The literal references are a temporary measure; the request will fail at the RMQ broker (no handler registered) — observable, not silent. Task-09 deletes both the inline literals and the legacy gateway routes.
7. **Forward links.** Doc 02 covers the new `Cart` aggregate; doc 03 covers `Order` + the three orthogonal status fields; doc 04 covers the new `Address`-snapshot policy; doc 05 covers the `PAYMENT_GATEWAY` port-and-adapter.

Task-12 appends the closing snapshot: the before/after schema diagram (mermaid or ASCII) and a list of which surfaces are now `variantId`/`Idempotency-Key`/`PAYMENT_GATEWAY`-aware (the table columns, the HTTP paths, the new RMQ routing keys, the gateway port).

## Carryover produced (consumed by task-02 onward)

- The five old tables are gone from MySQL.
- The entity files + mappers + legacy domain models + legacy events + legacy use cases + legacy publisher + legacy inventory-confirm adapter are gone from disk.
- `OrderTypeormRepository` is a throwing stub. Its constructor takes only the Pino logger and the DI binding `{ provide: ORDER_REPOSITORY, useExisting: OrderTypeormRepository }` still resolves.
- `DatabaseModule.forFeature([])` in `orders.module.ts` — ready for task-02 (cart) to land its `forFeature([Cart, CartLine])` after it carves out its own `modules/cart/` folder; ready for task-03 to add `[Order, OrderLine, Address]` to the `orders.module.ts` `forFeature`.
- The three RPC routing keys are gone from `libs/messaging/`; the three event keys remain (retired by task-06).
- The gateway adapter compiles against inline string literals — task-09 deletes both the literals and the legacy gateway controller.
- Doc `01-retail-rebuild-and-old-tables-dropped.md` exists with the introductory half written.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`); no unused-import warnings in the rewritten files.
- [ ] `yarn test:unit` passes; the surviving specs are green; no new specs are added or skipped.
- [ ] `yarn build` succeeds across the monorepo.
- [ ] `docker compose up -d && yarn migration:run` runs the new `DropLegacyRetailTables` migration without error; `mysql -e "SHOW TABLES"` shows none of `order`, `order_product`, `order_status`, `order_product_status`, `customer`.
- [ ] `yarn start:dev:retail-microservice` boots; an `retail.order.create` RPC call (via `rabbitmqadmin publish`) produces a Nest "no handler registered" RMQ error frame.
- [ ] `git ls-files apps/retail-microservice/src/modules/orders/infrastructure/persistence/` shows only `order-typeorm.repository.ts`, `index.ts` — and no `*.entity.ts` / `*.mapper.ts` files.
- [ ] `grep -rE "ROUTING_KEYS.RETAIL_ORDER_(CREATE|CONFIRM|GET)\b" apps libs` returns zero matches (the inline-literal workaround in the gateway adapter is the only remaining reference and uses string literals).
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `01-retail-rebuild-and-old-tables-dropped.md` exists with the seven sections above filled.
