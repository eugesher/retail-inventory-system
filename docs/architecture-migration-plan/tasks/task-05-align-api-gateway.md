# task-05 — Align API Gateway to hexagonal layout (Phase 2)

## Context

- Migration plan: `docs/architecture-migration-plan/parts/recommendation.md`
- Conventions preamble: `docs/architecture-migration-plan/tasks/task-01-review-project-and-update-plan.md`
- Previous carryover: `docs/architecture-migration-plan/tasks/_carryover-04.md`
- Project conventions: `CLAUDE.md`
- Where we are in the migration: all libs are in place. This task
  reshapes the gateway app into the per-module
  `application/domain/infrastructure/presentation` layout the
  recommendation prescribes, makes its proxy controllers consume the
  new `@retail-inventory-system/messaging` ports, and wires the
  observability tracer as the first import in `main.ts`. **Auth is
  out of scope here** — it is built from scratch in task-06 against
  the layout this task establishes.

## Prerequisites

- [ ] `_carryover-04.md` exists and was read first.
- [ ] Build is green on entry.

## Goal

Convert `apps/api-gateway/src/` from its current
`app/api/<feature>/` flat layout into
`src/modules/<feature>/{application,domain,infrastructure,presentation}/`
per the recommendation. The gateway is mostly a presentation layer (it
delegates to other services via RabbitMQ), so its `domain/` and
`application/` folders are slim — but the structure must still be in
place so the lint rules in task-12 can enforce it uniformly. The
`order` and `product` modules are renamed to `retail` and
`inventory` to reflect what the proxies talk to (downstream
microservices), not the surface URL.

## Steps

1. **Inventory `apps/api-gateway/src/`.** Today the gateway has
   exactly two feature folders:
   - `app/api/order/` — `OrderController` (HTTP `POST /api/order`,
     `PUT /api/order/:id/confirm`), `OrderConfirmService`,
     `OrderCreateService`, `OrderConfirmPipe`.
   - `app/api/product/` — `ProductController` (HTTP
     `GET /product/:productId/stock`), `ProductStockGetService`,
     `ProductStockGetQueryDto`.
   Plus `app/common/utils/throw-rpc-error.util.ts` and
   `app.module.ts` (registers `CorrelationMiddleware`).

2. **Create the modules skeleton.**
   `apps/api-gateway/src/modules/{retail,inventory}/{application/{use-cases,ports,dto},infrastructure/messaging,presentation/dto}/`.
   The `domain/` folder is intentionally omitted at the gateway
   today — there is no aggregate state to enforce. Task-06 will add
   `modules/auth/` with a real `domain/` for User/Role.

3. **Move the order proxy** to `modules/retail/`:
   - `OrderController` → `modules/retail/presentation/order.controller.ts`.
   - `OrderConfirmPipe` → `modules/retail/presentation/pipes/`.
   - `OrderConfirmService` and `OrderCreateService` →
     `modules/retail/application/use-cases/`, renamed
     `confirm-order.use-case.ts` and `create-order.use-case.ts`.
     Class names follow: `ConfirmOrderUseCase`, `CreateOrderUseCase`.

4. **Move the product proxy** to `modules/inventory/`:
   - `ProductController` →
     `modules/inventory/presentation/product.controller.ts`.
   - `ProductStockGetQueryDto` →
     `modules/inventory/presentation/dto/`.
   - `ProductStockGetService` →
     `modules/inventory/application/use-cases/get-product-stock.use-case.ts`.

5. **Define gateway ports** in
   `modules/retail/application/ports/retail-gateway.port.ts` and
   `modules/inventory/application/ports/inventory-gateway.port.ts`.
   Each port exposes the methods the controller needs:
   - Retail: `createOrder(cmd, correlationId)`,
     `confirmOrder(id, correlationId)`.
   - Inventory: `getProductStock(query, correlationId)`.

6. **Implement adapters** in
   `modules/<svc>/infrastructure/messaging/<svc>-rabbitmq.adapter.ts`.
   Each adapter holds the injected `ClientProxy` from
   `@retail-inventory-system/messaging` and turns port calls into
   `client.send()` invocations. Routing keys come from
   `@retail-inventory-system/messaging/routing-keys.constants.ts`
   (the new dotted form, if task-04 chose to rename — otherwise
   the existing snake_case enum values).

7. **Use cases call ports, not `ClientProxy`.** Both
   `ConfirmOrderUseCase` and `GetProductStockUseCase` currently
   inject `ClientProxy` directly. Inject the port symbols instead;
   the adapters resolve via Nest DI in
   `modules/<svc>/infrastructure/<svc>.module.ts`. Re-run
   `grep -r 'ClientProxy' apps/api-gateway/src` — only adapter
   files should match.

8. **Use `@retail-inventory-system/contracts` imports** for any
   cross-boundary DTO. The current code already imports
   `OrderConfirmResponseDto`, `OrderCreateDto`, `OrderCreateResponseDto`
   from `@retail-inventory-system/retail`; after task-03 these are
   under `@retail-inventory-system/contracts/retail`. Update the
   imports here.

9. **Wire the request-correlation middleware** from
   `@retail-inventory-system/observability` in `app.module.ts`.
   It currently lives in
   `@retail-inventory-system/common/correlation` — task-04 moved
   it to `observability`. Behaviour is unchanged (sets
   `x-correlation-id` request/response header).

10. **Make `import '@retail-inventory-system/observability/tracer';`
    the first line of `apps/api-gateway/src/main.ts`.** The order
    matters — OTel must be initialized before any instrumented
    module loads. The tracer file is a side-effect import (no
    exports needed at the call site).

11. **Run E2E.** `test/system-api.e2e-spec.ts` covers the full
    HTTP order/stock flow against MySQL/Redis/RabbitMQ. It must
    stay green after the gateway alignment. If the snapshot shifts
    (e.g., a renamed controller class name leaks into a log line),
    update the snapshot deliberately and call it out in
    `_carryover-05.md`.

## Documentation updates required

- [ ] `README.md`: update the "Architecture" / "Service Structure"
  section to show the gateway's new per-module layout
  (`modules/{retail,inventory}/{application,infrastructure,presentation}/`).
- [ ] `CLAUDE.md`: replace the existing "Service Structure" block
  (which documents the current flat `app/api/<feature>/providers/`
  layout) with the per-module hexagonal layout. Add a note that
  the gateway has **no `domain/` aggregate of its own** —
  task-06 will add `modules/auth/` with a real `domain/`.
- [ ] `docs/adr/NNN-port-adapter-at-the-gateway.md`: new ADR
  recording the gateway's port-and-adapter split and the rule that
  controllers/use-cases never inject `ClientProxy` directly.

## Verification

- [ ] `yarn install` succeeds.
- [ ] `yarn build` succeeds for all four apps.
- [ ] `yarn lint` succeeds.
- [ ] `yarn test:unit` succeeds.
- [ ] `yarn test:e2e` succeeds end-to-end (full
  `test/system-api.e2e-spec.ts` flow).
- [ ] No file under `apps/api-gateway/src/` imports `ClientProxy`
  outside an `infrastructure/messaging/*-rabbitmq.adapter.ts` file.
- [ ] `apps/api-gateway/src/main.ts`'s first import is
  `@retail-inventory-system/observability/tracer`.

## Carryover

Write `_carryover-05.md` with:
- File-rename map (old path → new path) for the gateway.
- Use-case map (old service → new use-case class name).
- Whether any e2e snapshot needed updating, and the diff.
- Verification results.
- Any cross-cutting concerns deferred to later tasks (e.g., trace
  context propagation across RabbitMQ headers — see task-10).
- Suggested adjustments to task-06 (auth) — particularly any
  decision about how the new `auth` module mounts under
  `modules/`.
