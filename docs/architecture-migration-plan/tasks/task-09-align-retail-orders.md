# task-09 — Align Retail/orders module to hexagonal layout (Phase 6)

## Context

- Migration plan: `docs/architecture-migration-plan/parts/recommendation.md`
- Conventions preamble: `docs/architecture-migration-plan/tasks/task-01-review-project-and-update-plan.md`
- Previous carryover: `docs/architecture-migration-plan/tasks/_carryover-08.md`
- Project conventions: `CLAUDE.md`
- Where we are in the migration: notification, inventory, and the
  gateway have been reshaped. Retail is the last service in the
  per-module pass. **Retail has only one feature today — orders.**
  The retail-microservice does not own a `products` module
  (product stock is owned by inventory; retail's role is order
  lifecycle). If a retail-side product aggregate is introduced
  later, that becomes a new task created at that time, not a
  reserved slot here.

## Prerequisites

- [ ] `_carryover-08.md` exists and was read first.
- [ ] Build is green on entry.
- [ ] `@retail-inventory-system/contracts/retail/` exposes order
  events (`order.created`, `order.confirmed`, `order.cancelled`)
  and the inventory `order.confirm` request contract.

## Goal

Reshape `apps/retail-microservice/src/` from its current
`app/api/order/` layout into per-module
`{application,domain,infrastructure,presentation}` directories under
`modules/orders/`. The existing `OrderConfirmDomain` state-transition
class (and its spec) folds into the new aggregate root. The
`ConfirmOrderUseCase` orchestrates a cross-service call into
inventory's `inventory.order.confirm` handler, so this task also
formalizes the `inventory-confirm.gateway.port.ts` that orders
depends on.

## Steps

1. **Inventory the orders code.** Today:
   - `app/api/order/order.controller.ts` (handlers for
     `RETAIL_ORDER_CREATE`, `RETAIL_ORDER_CONFIRM`,
     `RETAIL_ORDER_GET`).
   - `app/api/order/providers/{order-create,order-confirm,order-get}.service.ts`.
   - `app/api/order/pipes/{order-create,order-confirm}.pipe.ts`.
   - `app/api/order/domain/order-confirm.domain.ts` plus its spec
     (`order-confirm.domain.spec.ts`) — this is the existing
     state-transition computer that decides
     "skipUpdate / someProductsConfirmed / allProductsConfirmed".
   - `app/common/entities/{customer,order,order-product,order-status,order-product-status}.entity.ts`.
   The cross-service flow Orders → Inventory uses
   `MicroserviceMessagePatternEnum.INVENTORY_ORDER_CONFIRM` — the
   payload type is `IProductStockOrderConfirmPayload` from
   `@retail-inventory-system/contracts/inventory`.

2. **Create module skeleton** at
   `apps/retail-microservice/src/modules/orders/{application,domain,infrastructure,presentation}/`.

3. **Domain.**
   - `domain/order.model.ts` — Order aggregate root. Holds
     `OrderProduct[]` line items, status. Constructor and state
     transitions enforce invariants (cannot confirm twice, cannot
     confirm an empty order). `confirm(confirmedProductIds)`
     consumes the result the existing `OrderConfirmDomain`
     computes; that class folds in here as a private method or
     becomes a dedicated `confirm-order.specification.ts` next
     door (decide and document).
   - `domain/order-product.model.ts` — child entity inside the
     Order aggregate.
   - `domain/order-status.value-object.ts`,
     `domain/order-product-status.value-object.ts`.
   - `domain/customer.model.ts` (the Customer entity surfaces
     today; promote to a value object referenced by `Order` rather
     than its own aggregate — Order owns its customer reference).
   - `domain/events/order-created.event.ts`,
     `order-confirmed.event.ts`, `order-cancelled.event.ts`.

4. **Application.**
   - `application/ports/order.repository.port.ts`,
     `order-events.publisher.port.ts`,
     `inventory-confirm.gateway.port.ts` (the port that calls
     into the inventory microservice via RabbitMQ to reserve
     stock).
   - `application/use-cases/`:
     - `create-order.use-case.ts` (was `OrderCreateService`).
     - `confirm-order.use-case.ts` (was `OrderConfirmService`).
       The transactional update and the post-commit publish stay
       within this use case; the side-effects route through
       ports, not directly through `Repository<Order>`.
     - `get-order.use-case.ts` (was `OrderGetService`).
     - `cancel-order.use-case.ts` (**new** — only if a cancel
       flow makes sense today; otherwise defer).
   - `application/dto/`: command, query, view DTOs.

5. **Infrastructure.**
   - `infrastructure/persistence/`:
     - `order.entity.ts`, `order-product.entity.ts`,
       `order-status.entity.ts`,
       `order-product-status.entity.ts`,
       `customer.entity.ts` — relocated from
       `app/common/entities/`.
     - `order.mapper.ts`, `order-product.mapper.ts`,
       `customer.mapper.ts`.
     - `order-typeorm.repository.ts` implements
       `OrderRepositoryPort`.
   - `infrastructure/messaging/`:
     - `order-rabbitmq.publisher.ts` — emits
       `retail.order.created`, `retail.order.confirmed`,
       `retail.order.cancelled`.
     - `inventory-confirm.rabbitmq.adapter.ts` — implements
       `InventoryConfirmGatewayPort` by sending an
       `inventory.order.confirm` request via `ClientProxy.send`
       and awaiting the reply.
   - `infrastructure/orders.module.ts`.

6. **Presentation.**
   - `presentation/orders.controller.ts` — handlers for
     `retail.order.create`, `retail.order.confirm`,
     `retail.order.get` message patterns. Use cases injected.
   - `presentation/pipes/`: relocated `order-create.pipe.ts`,
     `order-confirm.pipe.ts`.
   - `presentation/dto/`: any presentation-only DTOs.

7. **Cross-service consistency.** Verify (and update, if needed)
   that the inventory side of the `inventory.order.confirm`
   request — implemented in task-08 under inventory — uses the
   same contract from
   `@retail-inventory-system/contracts/inventory`. Add a contract
   test asserting the request/response shape (a TypeScript
   compile-time check is fine — both sides import the same
   interface).

8. **Wire into `app.module.ts`** and remove the old
   `app/api/order/` and `app/common/entities/` paths once every
   consumer is repointed.

9. **Tests.**
   - **Migrate** `order-confirm.domain.spec.ts` to the new path
     under `modules/orders/domain/spec/` — assertions stay the
     same; only the import path changes.
   - Add unit tests for each use case with in-memory port
     doubles. Especially: `ConfirmOrderUseCase` with a stub
     `InventoryConfirmGatewayPort` returning
     "stock-confirmed" / "stock-insufficient" / "timeout".
   - Mapper round-trip test (entity ↔ domain) for Order +
     OrderProduct.
   - **End-to-end** is `test/system-api.e2e-spec.ts` — the full
     flow gateway → retail.order.create → retail.order.confirm
     → inventory.order.confirm → notification (added in task-07)
     should now run green for the first time. Capture the run
     output verbatim in `_carryover-09.md`; this is the
     migration's first end-to-end smoke that exercises every
     reshaped service.

## Documentation updates required

- [ ] `README.md`: confirm the "Architecture" section still
  describes the cross-service order flow correctly. If the
  diagram drifts, update it. Verify the `RETAIL_ORDER_*`
  pattern names match whatever task-04 chose (snake_case kept or
  dotted form).
- [ ] `CLAUDE.md`: update the message-pattern table to match —
  preserve whichever naming the codebase carries.
- [ ] `docs/adr/NNN-order-aggregate-and-cross-service-confirm.md`:
  new ADR documenting the Order aggregate, the cross-service
  confirm flow, and the gateway-port pattern that lets the use
  case mock the inventory side in tests.

## Verification

- [ ] `yarn install` succeeds.
- [ ] `yarn build` succeeds for all four apps.
- [ ] `yarn lint` succeeds.
- [ ] `yarn test:unit` succeeds.
- [ ] `yarn test:e2e` succeeds end-to-end for the order-confirm
  cross-service flow (the headline test of the migration).
- [ ] No file under `apps/retail-microservice/src/modules/orders/`
  imports `ClientProxy` or `Repository<...>` outside of
  `infrastructure/`.

## Carryover

Write `_carryover-09.md` with:
- File-rename map for orders.
- Use-case map.
- Tests migrated (paths) + tests added (paths + counts).
- Verification results — including the **raw e2e output** for the
  cross-service flow (this is the first time every service
  exercises the new shape end-to-end; the verbatim output is the
  receipt).
- A note that retail's Phase 6 is now complete, and that no
  separate retail-products task is queued (the recommendation
  records that one would be added if such a module ever shows
  up).
- Suggested adjustments to task-10 (OTel/Jaeger) — particularly
  whether any RabbitMQ context-propagation gap surfaced during
  the e2e run.
