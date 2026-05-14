# _carryover-09.md — Align Retail/orders module to hexagonal layout (Phase 6)

> Generated 2026-05-14 by the task-09 session on branch
> `RIS-33-Architecture-migration-Phase-9-Align-Retail-orders-module-to-hexagonal-layout`.
> The next task (`task-10`) reads this file as its first action and fails fast
> if it is missing.

## 1. Entry-gate result

`yarn install`, `yarn build` (4 apps), `yarn lint`, `yarn test:unit` (107
tests across 21 suites) were all green at the start of the session.
Baseline matches `_carryover-08.md`'s reported state.

## 2. File-rename map (legacy → new)

### Source files

| Legacy path | New path |
|---|---|
| `apps/retail-microservice/src/app/api/order/order.controller.ts` | `apps/retail-microservice/src/modules/orders/presentation/orders.controller.ts` |
| `apps/retail-microservice/src/app/api/order/order.module.ts` | replaced by `apps/retail-microservice/src/modules/orders/infrastructure/orders.module.ts` |
| `apps/retail-microservice/src/app/api/order/providers/order-create.service.ts` | `apps/retail-microservice/src/modules/orders/application/use-cases/create-order.use-case.ts` |
| `apps/retail-microservice/src/app/api/order/providers/order-confirm.service.ts` | `apps/retail-microservice/src/modules/orders/application/use-cases/confirm-order.use-case.ts` |
| `apps/retail-microservice/src/app/api/order/providers/order-get.service.ts` | `apps/retail-microservice/src/modules/orders/application/use-cases/get-order.use-case.ts` (now returns `{ statusId }` only) |
| `apps/retail-microservice/src/app/api/order/pipes/order-create.pipe.ts` | `apps/retail-microservice/src/modules/orders/presentation/pipes/order-create.pipe.ts` (rewritten to go through `ORDER_REPOSITORY`) |
| `apps/retail-microservice/src/app/api/order/pipes/order-confirm.pipe.ts` | `apps/retail-microservice/src/modules/orders/presentation/pipes/order-confirm.pipe.ts` (rewritten to go through `ORDER_REPOSITORY`) |
| `apps/retail-microservice/src/app/api/order/domain/order-confirm.domain.ts` | folded into `apps/retail-microservice/src/modules/orders/domain/order.model.ts` as `Order.applyInventoryConfirmation` |
| `apps/retail-microservice/src/app/common/entities/order.entity.ts` | `apps/retail-microservice/src/modules/orders/infrastructure/persistence/order.entity.ts` |
| `apps/retail-microservice/src/app/common/entities/order-product.entity.ts` | `apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-product.entity.ts` |
| `apps/retail-microservice/src/app/common/entities/order-status.entity.ts` | `apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-status.entity.ts` |
| `apps/retail-microservice/src/app/common/entities/order-product-status.entity.ts` | `apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-product-status.entity.ts` |
| `apps/retail-microservice/src/app/common/entities/customer.entity.ts` | `apps/retail-microservice/src/modules/orders/infrastructure/persistence/customer.entity.ts` |
| `apps/retail-microservice/src/app/common/entities/index.ts` | replaced by `apps/retail-microservice/src/modules/orders/infrastructure/persistence/index.ts` (exports `orderEntities`) |

### Folders deleted

- `apps/retail-microservice/src/app/api/` — gone.
- `apps/retail-microservice/src/app/common/` — gone. `app/` retains only `app.module.ts` + `index.ts`.

### New cross-cutting files

| Path | Role |
|---|---|
| `libs/contracts/retail/events/order-confirmed.event.ts` | New `IRetailOrderConfirmedEvent` wire contract (published by retail when an Order flips to fully-confirmed; no cross-service consumer yet). |
| `libs/contracts/retail/events/order-cancelled.event.ts` | New `IRetailOrderCancelledEvent` wire contract (reserved for the future cancel flow). |
| `libs/messaging/routing-keys.constants.ts` | Added `RETAIL_ORDER_CONFIRMED` and `RETAIL_ORDER_CANCELLED` dotted keys; mirrored on `MicroserviceMessagePatternEnum`. |
| `docs/adr/013-order-aggregate-and-cross-service-confirm.md` | New ADR documenting the Order aggregate, the cross-service confirm flow, and the gateway-port pattern. |

## 3. Use-case map (old `*.service.ts` → new `*.use-case.ts`)

| Legacy class | New class |
|---|---|
| `OrderCreateService` | `CreateOrderUseCase` |
| `OrderConfirmService` | `ConfirmOrderUseCase` |
| `OrderGetService` (returned full `Order \| null`) | `GetOrderUseCase.findHeaderById` (now returns `{ statusId } \| null` — the gateway pipe only needs the status) |
| `OrderConfirmDomain` (standalone state-transition class) | folded into `Order.applyInventoryConfirmation` on the aggregate |

The transactional update path (line-status + header flip) used to live in
`OrderConfirmService.execute` via `orderRepository.manager.transaction`. It
now lives behind `IOrderRepositoryPort.confirmLines`, which the adapter
implements with the same `EntityManager.update` + `In(...)` shape.

## 4. New module files

```
apps/retail-microservice/src/modules/orders/
  domain/
    order.model.ts                          # AggregateRoot<number|null>; applyInventoryConfirmation folds OrderConfirmDomain
    order-product.model.ts                  # Entity<number|null>
    customer.model.ts                       # ValueObject<{id}>
    order-status.value-object.ts            # OrderStatusVO (PENDING / CONFIRMED)
    order-product-status.value-object.ts    # OrderProductStatusVO (PENDING / CONFIRMED)
    events/
      order-created.event.ts                # extends DomainEvent<number>
      order-confirmed.event.ts
      order-cancelled.event.ts
      index.ts
    index.ts
    spec/
      order.model.spec.ts                   # 16 tests (migrated 11 from order-confirm.domain.spec + 5 side-effect tests)
      order-create.model.spec.ts            # 4 tests on the factory invariants
  application/
    ports/
      order.repository.port.ts              # IOrderRepositoryPort + ORDER_REPOSITORY
      order-events.publisher.port.ts        # IOrderEventsPublisherPort + ORDER_EVENTS_PUBLISHER
      inventory-confirm.gateway.port.ts     # IInventoryConfirmGatewayPort + INVENTORY_CONFIRM_GATEWAY
      index.ts
    use-cases/
      create-order.use-case.ts
      confirm-order.use-case.ts
      get-order.use-case.ts
      index.ts
      spec/
        test-doubles.ts                     # InMemoryOrderRepository / InMemoryInventoryConfirmGateway / InMemoryOrderEventsPublisher (jest-free)
        create-order.use-case.spec.ts       # 3 tests
        confirm-order.use-case.spec.ts      # 6 tests (stock-confirmed / stock-insufficient / timeout / not-found / publish-fail)
        get-order.use-case.spec.ts          # 2 tests
  infrastructure/
    persistence/
      customer.entity.ts
      order.entity.ts
      order-product.entity.ts
      order-product-status.entity.ts
      order-status.entity.ts
      customer.mapper.ts
      order.mapper.ts
      order-product.mapper.ts
      order-typeorm.repository.ts           # IOrderRepositoryPort adapter; also owns customer-exists + product-id existence checks
      index.ts                              # exports `orderEntities` + symbols
      spec/
        order.mapper.spec.ts                # 2 tests — entity → domain round-trip
    messaging/
      order-rabbitmq.publisher.ts           # ORDER_EVENTS_PUBLISHER adapter; emits retail.order.created/confirmed/cancelled
      inventory-confirm.rabbitmq.adapter.ts # INVENTORY_CONFIRM_GATEWAY adapter; wraps ClientProxy.send for inventory.order.confirm
      index.ts
    orders.module.ts                        # binds ORDER_REPOSITORY/ORDER_EVENTS_PUBLISHER/INVENTORY_CONFIRM_GATEWAY
  presentation/
    orders.controller.ts                    # @MessagePattern handlers for RETAIL_ORDER_CREATE/CONFIRM/GET
    pipes/
      order-create.pipe.ts                  # injects ORDER_REPOSITORY (no Repository<...> leak)
      order-confirm.pipe.ts                 # injects ORDER_REPOSITORY (no Repository<...> leak)
      index.ts
```

## 5. Tests migrated / added

### Migrated

| Legacy spec | New spec(s) |
|---|---|
| `apps/retail-microservice/src/app/api/order/domain/spec/order-confirm.domain.spec.ts` (11 tests) | `apps/retail-microservice/src/modules/orders/domain/spec/order.model.spec.ts` — assertions preserved verbatim against the new `Order.applyInventoryConfirmation` return type; 5 additional side-effect tests cover the new transitions (line-status flip, header flip + OrderConfirmedEvent recording, already-confirmed throw, newlyConfirmedProductIds order). |

### Added

| Spec | Coverage |
|---|---|
| `apps/retail-microservice/src/modules/orders/domain/spec/order-create.model.spec.ts` | 4 tests — per-quantity expansion, empty-lines rejection, quantity-must-be-positive, no-event-from-factory |
| `apps/retail-microservice/src/modules/orders/application/use-cases/spec/create-order.use-case.spec.ts` | 3 tests — happy path with publish, publish-rejected warn-log, repo-rejected rethrow |
| `apps/retail-microservice/src/modules/orders/application/use-cases/spec/confirm-order.use-case.spec.ts` | 6 tests — stock-confirmed (header flips, event published), stock-insufficient (partial confirm, no event), no-stock (skipUpdate), timeout (rethrow + no DB write), aggregate-disappeared (throw), publish-fail (warn-log + still succeeds) |
| `apps/retail-microservice/src/modules/orders/application/use-cases/spec/get-order.use-case.spec.ts` | 2 tests — header lookup, missing returns null |
| `apps/retail-microservice/src/modules/orders/infrastructure/persistence/spec/order.mapper.spec.ts` | 2 tests — entity → domain round-trip (pending and confirmed) |

Final unit-test totals: **128 tests passing across 26 suites** (was 107
across 21 suites). Net new = 21 tests; the migration kept every legacy
assertion of the `OrderConfirmDomain` contract and added the new
aggregate-invariant, use-case-behavior, and mapper-round-trip tests the
task brief asked for.

### End-to-end

`test/system-api.e2e-spec.ts` exercises the full
gateway → retail.order.create → retail.order.confirm → inventory.order.confirm
flow against the live containers. This is the **first migration phase that
runs every reshaped service together end-to-end** — and it is green. The
notification `e2e-spec.ts` keeps using its synthetic publish, but the
retail publisher now does the same on the live path, so the producer is
observable in the API gateway logs.

Verbatim e2e output:

```
Test Suites: 3 passed, 3 total
Tests:       35 passed, 35 total
Snapshots:   42 passed, 42 total
Time:        12.049 s, estimated 19 s
Ran all test suites.
Force exiting Jest: Have you considered using `--detectOpenHandles` to detect async operations that kept running after all tests finished?
```

## 6. Verification results

```
$ yarn install
➤ YN0000: ┌ Link step
➤ YN0000: └ Completed in 0s 435ms
➤ YN0000: · Done in 2s 27ms

$ yarn build
webpack 5.106.0 compiled successfully in 9318 ms   # api-gateway
webpack 5.106.0 compiled successfully in 9746 ms   # inventory-microservice
webpack 5.106.0 compiled successfully in 10331 ms  # retail-microservice
webpack 5.106.0 compiled successfully in 9438 ms   # notification-microservice

$ yarn lint
# (no output — clean exit code 0)

$ yarn test:unit
Test Suites: 26 passed, 26 total
Tests:       128 passed, 128 total
Snapshots:   0 total
Time:        26.572 s

$ yarn test:e2e
Test Suites: 3 passed, 3 total
Tests:       35 passed, 35 total
Snapshots:   42 passed, 42 total
Time:        12.049 s

$ grep -rn '@Entity' apps/retail-microservice/src
apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-status.entity.ts:5:@Entity('order_status')
apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-product-status.entity.ts:5:@Entity('order_product_status')
apps/retail-microservice/src/modules/orders/infrastructure/persistence/customer.entity.ts:9:@Entity('customer')
apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-product.entity.ts:16:@Entity('order_product')
apps/retail-microservice/src/modules/orders/infrastructure/persistence/order.entity.ts:17:@Entity('order')

$ grep -rn 'Repository<' apps/retail-microservice/src --include='*.ts' | grep -v '\.spec\.ts' | grep -v test-doubles
apps/retail-microservice/src/modules/orders/presentation/pipes/order-create.pipe.ts:14:// `Repository<...>` injection leaks out of `infrastructure/` (ADR-013).
apps/retail-microservice/src/modules/orders/application/ports/order.repository.port.ts:16:// pre-RPC existence checks and line-item load — keeping `Repository<...>`
apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-typeorm.repository.ts:24:    private readonly orderRepository: Repository<OrderEntity>,
apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-typeorm.repository.ts:26:    private readonly customerRepository: Repository<CustomerEntity>,
apps/retail-microservice/src/modules/orders/infrastructure/persistence/order-typeorm.repository.ts:79:    // `Repository<...>` outside `infrastructure/`) holds — see ADR-013.

$ grep -rn 'ClientProxy' apps/retail-microservice/src --include='*.ts' | grep -v test-doubles | grep -v 'application/ports' | grep -v 'application/use-cases'
apps/retail-microservice/src/modules/orders/infrastructure/messaging/inventory-confirm.rabbitmq.adapter.ts:2:import { ClientProxy } from '@nestjs/microservices';
apps/retail-microservice/src/modules/orders/infrastructure/messaging/inventory-confirm.rabbitmq.adapter.ts:17:    private readonly inventoryClient: ClientProxy,
apps/retail-microservice/src/modules/orders/infrastructure/messaging/order-rabbitmq.publisher.ts:2:import { ClientProxy } from '@nestjs/microservices';
apps/retail-microservice/src/modules/orders/infrastructure/messaging/order-rabbitmq.publisher.ts:20:    private readonly notificationClient: ClientProxy,
```

The only `Repository<...>` and `ClientProxy` injections in production code
live inside `infrastructure/`. Outside-`infrastructure/` occurrences are
comment text only. All seven verification gates pass.

## 7. ADR numbers assigned

- **ADR-013** — Order aggregate and the cross-service confirm flow. Status:
  Accepted. CLAUDE.md's "next free ADR" counter advanced to **014**.

## 8. Retail Phase 6 is complete

No separate retail-products task is queued — retail does not own a
`products` aggregate today (product stock is inventory's responsibility).
The recommendation records that one would be added if a retail-side product
module ever shows up.

## 9. Unexpected findings

1. **Pipes reach the DB; the boundary rule pushed them through the port.**
   The legacy pipes injected `Repository<Customer>`, `Repository<Order>`,
   and `DataSource` directly. Task-09's verification rule ("no
   `Repository<...>` outside `infrastructure/`") forced the queries into
   the `ORDER_REPOSITORY` port surface. New port methods:
   `customerExists(id)`, `findExistingProductIds(ids)`,
   `findConfirmableOrder(id)`. The use cases ignore these methods — the
   pipes are the only callers. Tracked as a follow-up for task-12 to
   formalize via `eslint-plugin-boundaries`.

2. **`findOrderResponse` returns the wire DTO directly from the adapter.**
   The confirm path's response JOINs `OrderStatus` and `OrderProductStatus`
   reference tables for `name` / `color` columns the e2e snapshots assert
   on. Rather than building those at the use-case layer (an extra DB
   round-trip or a domain → DTO mapper that needs the reference data), the
   adapter exposes `findOrderResponse(id): Promise<OrderConfirmResponseDto |
   null>`. This is a deliberate compromise — the contract DTO leaks into
   the port surface in exchange for one query, one response shape, and a
   thin use case.

3. **`OrderCreatedEvent` is constructed by the use case, not the
   aggregate.** Documented in ADR-013 §5. The aggregate cannot fabricate
   its own persisted id, and rewriting `aggregateId` after save would
   require mutating the `readonly` field on `DomainEvent`. `OrderConfirmed`
   records inside the aggregate because the confirm path runs against an
   already-persisted aggregate. Asymmetric across the two flows; future
   transactional-outbox work can unify them.

4. **`OrderGetService` returned the full Order entity; the new use case
   returns just the header.** The only consumer is the gateway's
   `OrderConfirmPipe`, which uses `getOrderStatus(id)` and discards
   everything but `statusId`. The wire payload is now `{ statusId } | null`.
   No client behavior change — the gateway pipe never read any other field.

5. **`ValueObject<TProps>` requires `extends Record<string, unknown>`.** TS
   2344 surfaces if the props interface omits the index-signature
   extension. Same gotcha as `Storage` in the inventory module's
   `storage.model.ts`. Applied to `CustomerRef`, `OrderStatusVO`, and
   `OrderProductStatusVO` props interfaces.

6. **`MicroserviceClientNotificationModule` was already in place.**
   Task-08 added it for `inventory.stock.low`; task-09 reuses it for
   `retail.order.created/confirmed/cancelled` without modification.

7. **`tsconfig.app.json` excludes `*.spec.ts` only.** The
   `test-doubles.ts` sibling file inside `application/use-cases/spec/` is
   jest-free (pure-TypeScript class implementations of the ports) so the
   production webpack build stays clean. Same constraint as
   `_carryover-07 §X` and `_carryover-08 §9 #5`.

8. **`OrderCreatedEvent` was simplified to not require id-rewrite tricks.**
   An earlier draft tried to emit the event from `Order.create` with a
   placeholder id (0) and rewrite it after save — but `DomainEvent.aggregateId`
   is `readonly` and `Object.freeze`d on the base. The cleaner pattern: the
   factory does not emit; the use case constructs and emits the event
   after the repo round-trip. Documented in ADR-013 §5.

## 10. Suggested adjustments to task-10 (OTel / Jaeger)

1. **The cross-service confirm flow is now a real trace target.** Before
   today, `retail.order.confirm → inventory.order.confirm` only existed in
   the inventory side's tests with a synthetic caller; the retail path was
   the legacy code. Task-10 should wire OTel spans around:
   - `RetailRabbitmqAdapter.confirmOrder` (gateway → retail)
   - `InventoryConfirmRabbitmqAdapter.reserveOrderStock` (retail → inventory)
   - `OrderRabbitmqPublisher.publishOrderCreated/Confirmed` (retail → notification)
   - `StockRabbitmqPublisher.publishStockLow` (inventory → notification)

   The trace shape is uniform — every adapter wraps `ClientProxy.send/emit`
   in `firstValueFrom`, so a single decorator at the adapter boundary picks
   up all four.

2. **No RabbitMQ context-propagation gap surfaced during the e2e run.**
   Correlation IDs flow on the wire payload (`ICorrelationPayload`) and
   thread through every log line in the e2e output (visible in the
   notification microservice's log dispatch). OTel will need to add
   `traceparent` headers on the message metadata; the existing
   `CorrelationMiddleware` does not touch RMQ headers today.

3. **`OrderTypeormRepository.findExistingProductIds` runs raw SQL against
   the `product` table.** Today this lives behind the orders port, but it
   reads inventory-owned data — the trace will show a cross-aggregate read
   on the retail node. Task-10 can either accept the read (it's
   pre-RPC validation, not a confirm-path query) or route it through an
   inventory RPC.

## 11. Open follow-ups (post-task-09)

1. **Topic-exchange migration.** `EXCHANGES.NOTIFICATION` is still
   reserved but unused — task-08 already flagged this. Now that retail
   emits three events (created/confirmed/cancelled) and inventory emits
   one (stock.low), the fan-out case for a topic exchange is stronger.
2. **`retail.order.cancelled` has no producer.** The aggregate's `cancel()`
   method and the publisher's `publishOrderCancelled` method exist but no
   use case calls them. A `CancelOrderUseCase` is the natural follow-up if
   the cancel HTTP route ever lands.
3. **`retail.order.confirmed` has no consumer.** Reserved port-shape work
   today. The notification microservice's `order-events.consumer.ts` only
   subscribes to `retail.order.created`; adding a confirmed-event subscriber
   is a one-method addition once a notification use case justifies it.
4. **`OrderRabbitmqPublisher` is a single adapter for three events.** If
   the cancel/confirmed events ever grow distinct delivery semantics
   (different queue, different exchange), the publisher could split. Today
   the three methods all target the same `NOTIFICATION_MICROSERVICE`
   ClientProxy.
5. **`IRetailOrderConfirmedEvent.correlationId` is required (same gotcha
   as `_carryover-08 §9 #4`).** The publisher defaults to `''` defensively;
   the use case always threads the real id. Worth relaxing at the contract
   level if a future producer can't always supply it.
