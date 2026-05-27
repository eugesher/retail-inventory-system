# ADR-013: Order aggregate and the cross-service confirm flow

- **Date**: 2026-05-14
- **Status**: Accepted (pipe-loader methods added to `IOrderRepositoryPort` post-ADR; see References)

---

## Context

Pre-task-09 the retail microservice was on the legacy flat layout:

- `apps/retail-microservice/src/app/api/order/`
  - `order.controller.ts` — `@MessagePattern` handlers for `RETAIL_ORDER_CREATE`, `RETAIL_ORDER_CONFIRM`, `RETAIL_ORDER_GET`.
  - `providers/order-{create,confirm,get}.service.ts` — one service per RPC.
  - `pipes/order-{create,confirm}.pipe.ts` — pre-RPC validation/loading.
  - `domain/order-confirm.domain.ts` — pure-class state-transition computer that decided "skipUpdate / someProductsConfirmed / allProductsConfirmed" for the confirm path.
- `apps/retail-microservice/src/app/common/entities/` — `Customer`, `Order`, `OrderProduct`, `OrderStatus`, `OrderProductStatus` TypeORM entities.

ADR-004 declared hexagonal-per-service as the target layout; ADR-011 elected
the notification microservice as the canonical per-module template; ADR-012
moved inventory into the same shape. Retail is the last service in the
per-module pass. The single bounded context today is `orders`. The cross-
service confirm flow (retail → inventory) is the migration's headline
end-to-end interaction, so this ADR also formalizes the gateway-port pattern
that lets the use case mock the inventory side in unit tests.

There is no `products` module on the retail side — product stock is owned by
inventory; retail's role is order lifecycle. A retail-side product aggregate,
if introduced later, becomes its own ADR at that time.

## Decision

### 1. Single `orders` bounded context

**Chosen.** The new module lives at
`apps/retail-microservice/src/modules/orders/`. The name follows the domain
aggregate (`Order`). Other entities currently in retail's schema
(`customer`, the reference tables `order_status` / `order_product_status`)
do not warrant their own bounded contexts today — the `customer` table is
read-only seed data, and the reference tables are presentational.

### 2. Domain layer

- `Order` extends `AggregateRoot<number | null>` from
  `@retail-inventory-system/ddd`. The `number | null` parameterization
  reflects the transient (pre-persistence) state of an aggregate built by
  `Order.create({...})`; once the typeorm repository assigns an id, the
  reconstituted aggregate carries the persisted id.
- Invariants enforced on the aggregate:
  - line items array is non-empty (an empty order cannot exist).
  - `applyInventoryConfirmation()` is rejected when the header status is
    already `CONFIRMED`.
  - line-item statuses only ever transition `PENDING → CONFIRMED`.
- `OrderProduct` is a child entity (extends `Entity<number | null>`) — not
  its own aggregate. The Order aggregate owns the lifecycle of its lines.
- `CustomerRef` is a `ValueObject<{ id }>` referenced by Order. Retail
  does not maintain a Customer aggregate of its own; promoting the
  legacy `Customer` entity to a VO inside the Order aggregate avoids a
  spurious cross-aggregate reference.
- `OrderStatusVO` / `OrderProductStatusVO` are VOs wrapping the existing
  `OrderStatusEnum` / `OrderProductStatusEnum` from
  `@retail-inventory-system/contracts`. Transition predicates
  (`isPending` / `isConfirmed`) live on the type rather than scattered
  through use cases.
- Three in-process domain events extend `DomainEvent<number>`:
  `OrderCreatedEvent`, `OrderConfirmedEvent`, `OrderCancelledEvent`.

The legacy `OrderConfirmDomain` state-transition computer folds into
`Order.applyInventoryConfirmation(...)` — it returns an
`IOrderConfirmationResult` carrying the same three flags
(`someProductsConfirmed / allProductsConfirmed / skipUpdate`) plus the
newly-confirmed line ids the persistence adapter needs.

### 3. Three application ports, three concrete adapters

- `IOrderRepositoryPort` (DI symbol `ORDER_REPOSITORY`) — inbound
  persistence. Methods: `findById`, `findHeaderById`,
  `findOrderResponse` (full JOIN'd `OrderConfirmResponseDto`), `save`,
  `confirmLines` (transactional line-status + header update). Adapter:
  `OrderTypeormRepository`.
- `IOrderEventsPublisherPort` (DI symbol `ORDER_EVENTS_PUBLISHER`) —
  outbound event emission. Adapter: `OrderRabbitmqPublisher`, which
  wraps `ClientProxy.emit()` and the `firstValueFrom` materialization
  so application code awaits a plain Promise. Targets the
  `NOTIFICATION_MICROSERVICE` ClientProxy from
  `MicroserviceClientNotificationModule` (added in task-08 for the
  inventory `stock.low` flow).
- `IInventoryConfirmGatewayPort` (DI symbol `INVENTORY_CONFIRM_GATEWAY`)
  — outbound cross-service call to the inventory microservice's
  `inventory.order.confirm` handler. Adapter:
  `InventoryConfirmRabbitmqAdapter`, which wraps `ClientProxy.send()`
  with the `IProductStockOrderConfirmPayload` wire contract from
  `@retail-inventory-system/contracts/inventory`.

The third port is the headline addition: `ConfirmOrderUseCase` injects
`INVENTORY_CONFIRM_GATEWAY` instead of a raw `ClientProxy`, which lets
the spec exercise the "stock-confirmed / stock-insufficient / timeout"
branches without booting RabbitMQ.

### 4. Use cases mirror the legacy `*.service.ts` files

| Legacy class | New use case |
|---|---|
| `OrderCreateService` | `CreateOrderUseCase` |
| `OrderConfirmService` | `ConfirmOrderUseCase` |
| `OrderGetService` | `GetOrderUseCase` |

- `CreateOrderUseCase` persists the aggregate, then publishes
  `retail.order.created` post-save. Publish failures are warn-logged
  but never raised — the order is already persisted, and the
  notification fan-out is a best-effort post-commit step.
- `ConfirmOrderUseCase` calls `INVENTORY_CONFIRM_GATEWAY` first, then
  fetches the aggregate, calls `applyInventoryConfirmation(...)`, and
  drives the persistence adapter through `confirmLines(...)`. If the
  aggregate flipped to `CONFIRMED`, the recorded `OrderConfirmedEvent`
  is drained via `pullDomainEvents()` and published; otherwise no event
  fires.
- `GetOrderUseCase.findHeaderById(id)` returns just the order header
  status — the API gateway's `OrderConfirmPipe` only needs that to
  short-circuit a non-PENDING confirm with a 400. The wire payload
  stays small.

A `cancel-order.use-case.ts` is **not** added today — the legacy
service did not expose a cancel flow and there is no consumer for
`retail.order.cancelled` yet. The aggregate's `cancel()` method and the
publisher port surface exist so a future cancel flow plugs in without
re-shaping the module.

### 5. Create-path events are constructed by the use case

**Chosen.** `Order.create({...})` does not record an `OrderCreated`
event from the factory. The create use case constructs the event after
the repository round-trip assigns the persisted id, then publishes it.

Rationale: the aggregate cannot fabricate its own id, and a placeholder
(`orderId: 0`) drifting out to subscribers is worse than letting the
use case shape the event with the real id. The confirm path is
different — `applyInventoryConfirmation(...)` always runs against an
already-persisted aggregate, so `OrderConfirmedEvent` records inside
the aggregate with the real id.

This is a deliberate asymmetry across the two flows. ADR-012 §6
documented the same trade-off for `stock.low` (emitted from the use
case rather than the aggregate). Future evolutions (transactional
outbox) can lift both paths into a unified pattern.

### 6. Wire-format contracts: events live in `libs/contracts/retail/events/`

`IRetailOrderCreatedEvent` was already in place from task-07. Task-09
adds:

- `IRetailOrderConfirmedEvent` — published when an Order flips to
  `CONFIRMED`. Reserved for future cross-service consumers; no
  subscriber today.
- `IRetailOrderCancelledEvent` — reserved for the future cancel flow.
  No producer or consumer today.

`ROUTING_KEYS` in `libs/messaging/routing-keys.constants.ts` gains
`RETAIL_ORDER_CONFIRMED` and `RETAIL_ORDER_CANCELLED` to match;
`MicroserviceMessagePatternEnum` in `libs/contracts/microservices/` is
kept in sync as required by `routing-keys.constants.spec.ts`.

### 7. Cross-service contract test is the TypeScript compile

Both the retail-side adapter (`InventoryConfirmRabbitmqAdapter`) and
the inventory-side handler (`StockController.handleOrderConfirm`)
import `IProductStockOrderConfirmPayload` from
`@retail-inventory-system/contracts`. Any drift in the payload shape
fails compilation on both ends simultaneously. The compile-time
coupling is the contract test; no separate runtime contract test is
added.

### 8. Test layout follows the inventory module's structure

- `domain/spec/` — `order.model.spec.ts` (migrated from the legacy
  `order-confirm.domain.spec.ts`, assertions preserved verbatim against
  the new `applyInventoryConfirmation` return type) + the new
  `order-create.model.spec.ts` covering the factory invariants.
- `application/use-cases/spec/` — one spec per use case plus a
  `test-doubles.ts` carrying in-memory `IOrderRepositoryPort`,
  `IInventoryConfirmGatewayPort`, and `IOrderEventsPublisherPort`
  implementations. `test-doubles.ts` is jest-free so the production
  build stays clean (the `tsconfig.app.json` excludes `*.spec.ts` only).
- `infrastructure/persistence/spec/order.mapper.spec.ts` — entity →
  domain round-trip for the create and confirm states.

## Consequences

- Retail now matches the inventory and notification modules'
  per-module hexagonal shape. The boundary rule "`ClientProxy` only
  inside `infrastructure/messaging/*-rabbitmq.{adapter,publisher}.ts`"
  is satisfied by the two messaging adapters.
- The legacy `app/api/order/` and `app/common/entities/` folders are
  deleted; their TypeORM entities are relocated under
  `modules/orders/infrastructure/persistence/`.
- `retail.order.created` now has a real producer for the first time —
  task-07's notification consumer was running against a synthetic
  publish in `test/notification.e2e-spec.ts` until now.
- The cross-service confirm flow `gateway → retail.order.confirm →
  inventory.order.confirm → notification (retail.order.created from
  the create path)` is exercised end-to-end by
  `test/system-api.e2e-spec.ts` for the first time.
- The seven verification gates (yarn install/build/lint/test:unit,
  yarn test:e2e end-to-end, `@Entity` location grep, no direct
  `Repository<...>` injection outside the typeorm adapter) all pass.

## Alternatives considered

1. **Record `OrderCreated` from inside the `Order.create` factory and mutate the event's aggregateId after save.** Rejected — `DomainEvent.aggregateId` is `readonly`, and rewriting it via `Object.assign` would have leaked a persistence concern into the domain.
2. **Skip the cross-service gateway port; inject `ClientProxy` directly into the confirm use case.** Rejected — the test asymmetry was the whole point. With the port, the spec drives "stock-confirmed / stock-insufficient / timeout" without RabbitMQ; without it the unit suite would either mock `firstValueFrom` or skip these branches.
3. **Promote `Customer` to its own aggregate inside the orders module.** Rejected — no behavior lives on it today (read-only seed data). The Order aggregate owns its customer reference as a `CustomerRef` VO.
4. **Emit `OrderConfirmed` from the use case, mirroring `stock.low`.** Considered — but the confirm path always runs against a persisted aggregate, so recording the event inside `applyInventoryConfirmation(...)` is straightforward and keeps the state transition + event emission co-located. The create-path asymmetry is documented in §5.

## References

- [ADR-004](004-adopt-hexagonal-architecture-per-service.md) — the
  per-module hexagonal target this module realizes.
- [ADR-011](011-notifier-port-and-adapters.md) /
  [ADR-012](012-stock-aggregate-and-port-adapter.md) — the per-module
  template and the inventory counterpart this module mirrors.
- [ADR-019](019-typeorm-and-mysql-for-persistence.md) — the
  TypeORM/MySQL stack `OrderTypeormRepository` builds on.
- [ADR-020](020-rabbitmq-as-inter-service-bus.md) — the broker the
  cross-service `inventory.order.confirm` RPC and the
  `retail.order.created` event travel over.
- **§3 `IOrderRepositoryPort` method enumeration.** The live port at
  `apps/retail-microservice/src/modules/orders/application/ports/order.repository.port.ts`
  has eight methods rather than the five enumerated here. The
  additional three — `findConfirmableOrder`, `customerExists`,
  `findExistingProductIds` — are pipe-time lookups added to support
  `OrderCreatePipe` / `OrderConfirmPipe` so the pipes can short-circuit
  invalid input at the presentation boundary without injecting the
  repository through a use case. The role of the port (inbound
  persistence behind `ORDER_REPOSITORY`, adapter `OrderTypeormRepository`)
  is unchanged.
