---
id: phase-05
title: Retail microservice
depends_on: [phase-04]
scope_paths:
  - apps/retail-microservice/**
estimated_files: 46
---

# Phase 05 — Retail microservice

## Goal
Apply the `simplify` skill to the retail microservice — single `orders` bounded context per ADR-013. Scope covers `apps/retail-microservice/src/{app,main.ts,modules/orders}` including domain (Order aggregate with line-item invariants + status transitions, OrderProduct child entity, OrderStatus / OrderProductStatus VOs, CustomerRef VO, OrderCreated / OrderConfirmed / OrderCancelled events), application (`IOrderRepositoryPort`, `IOrderEventsPublisherPort`, `IInventoryConfirmGatewayPort` + their DI symbols, plus `CreateOrderUseCase`, `ConfirmOrderUseCase`, `GetOrderUseCase`), infrastructure (TypeORM entities + mappers + `OrderTypeormRepository`, `OrderRabbitmqPublisher`, `InventoryConfirmRabbitmqAdapter`), and presentation (`OrdersController` with `@MessagePattern` handlers for `retail.order.create` / `retail.order.confirm` / `retail.order.get`, plus `OrderCreatePipe` / `OrderConfirmPipe`). Observable outcome: smaller per-file footprint with cross-service confirm seam (`INVENTORY_CONFIRM_GATEWAY`) intact.

## You Are Running In a Clean Context
This task file is everything you have. There is no prior memory of earlier phases. You must:

1. **Read** `tmp/tasks/simplify/carryover.md` in full before doing anything else. It contains established patterns from earlier phases that you must apply consistently — phases 03 and 04 ran the same kind of work on the notification and inventory microservices and will have left per-service conventions for you to mirror.
2. **Read** only the files under "Pre-read" below from `docs/adr/` and the repository.
3. **Do not** read `tmp/tasks/simplify/00-plan.md` or any other phase file — they are not part of your context.

## Pre-read
- `tmp/tasks/simplify/carryover.md` (full).
- `docs/adr/004-adopt-hexagonal-architecture-per-service.md` — per-module hexagonal layout.
- `docs/adr/013-order-aggregate-and-cross-service-confirm.md` — reshapes retail to single `orders` bounded context; introduces `INVENTORY_CONFIRM_GATEWAY` for the RPC seam.
- `docs/adr/008-rabbitmq-via-libs-messaging.md` — dotted `ROUTING_KEYS`; retail emits `retail.order.created` / `retail.order.confirmed` (and reserves `retail.order.cancelled`).
- `docs/adr/019-typeorm-and-mysql-for-persistence.md` — TypeORM + MySQL.
- `docs/adr/017-architecture-lint-via-eslint-boundaries.md` — boundaries rules are authoritative; `yarn lint` is the source of truth.
- Repository files in `scope_paths` above.

## Hard Constraints
Restate these in full — do not link out:

- **ADRs are immutable.** This phase must not steer the `simplify` skill toward changes that contradict ADR-004, ADR-008, ADR-013, ADR-017, ADR-018, ADR-019, ADR-020. In particular:
  - **Per-module hexagonal layout is preserved** — `domain/`, `application/{ports,use-cases}/`, `infrastructure/{messaging,persistence}/`, `presentation/`.
  - **Port DI symbols are frozen**: `ORDER_REPOSITORY`, `ORDER_EVENTS_PUBLISHER`, `INVENTORY_CONFIRM_GATEWAY`. None may be renamed.
  - **`InventoryConfirmRabbitmqAdapter` is the only allowed holder of `ClientProxy` in retail** — it wraps `ClientProxy.send` for `inventory.order.confirm`. Use cases and pipes inject the port symbol, not `ClientProxy`. Do not weaken the boundary.
  - **`@MessagePattern('retail.order.create')`, `@MessagePattern('retail.order.confirm')`, `@MessagePattern('retail.order.get')`** keep their pattern strings — they are the wire format. The routing-key constants live in `libs/messaging` (out of scope this phase).
  - **`OrderRabbitmqPublisher` emits `retail.order.created` after `CreateOrderUseCase` persists the aggregate** and emits `retail.order.confirmed` when `ConfirmOrderUseCase` flips an Order to fully-confirmed. `retail.order.cancelled` is reserved (no producer today); the publisher's surface keeps the reservation.
  - **`CustomerRef` VO and `Customer` TypeORM entity** are deliberately distinct — the VO is in `domain/`, the entity is in `infrastructure/persistence/`. The mapper bridges them. Do not collapse.
  - **Domain code is framework-free** — files under `apps/retail-microservice/src/modules/orders/domain/` must not import `@nestjs/*`, `@retail-inventory-system/messaging`, `…/cache`, `…/observability`, `…/database`, or `typeorm`.
  - **The application layer must not import `@nestjs/typeorm` or bare `typeorm`** — enforced by ESLint boundaries (ADR-017 §4); do not weaken a rule to make code pass.
  - **`main.ts` imports `@retail-inventory-system/observability/tracer` first.**
- **Behavior preservation.** Test suites listed under "Test commands" below must pass after this phase. If `simplify` removes code covered only by tests that become trivial, those tests may be removed; meaningful coverage may not be.
- **No artifacts in the code.** Do not add any comment, marker, file, or `README.md`/`CLAUDE.md` entry describing this pass. Do not append to any ADR.
- **Preserve audit annotations.** Lines tagged `AUDIT-2026-05-08 [...]` and `AUDIT-2026-05-20 [...]` must not be deleted.
- **No deletion under `tmp/`.** Do not delete, move, or rename anything under `tmp/`.
- **No files outside `tmp/tasks/simplify/`** other than in-place code modifications produced by the skill.
- **Out of scope, always**: `migrations/**`, `tests/lint/architecture-lint.spec.ts`, `tmp/**`, `dist/**`, `coverage/**`, `node_modules/**`, root-level `task.md` / `todo.md` / `nvim.md` / `http.md` / `a.md`, `docs/**`, `README.md`, `CLAUDE.md`, ADRs, `package.json`, `tsconfig.json`, ESLint / Prettier config files, `docker-compose*.yml`, `Dockerfile`. Also out of scope this phase: all of `libs/**`, `apps/api-gateway/**`, `apps/inventory-microservice/**`, `apps/notification-microservice/**`, `test/**`, `scripts/**`.
- **Idempotency.** If `carryover.md` shows this phase as completed under "Phase ledger → Completed", verify the repository state matches and exit. If partially completed, resume from the documented state.

## Procedure

1. **Verify entry state.** Confirm `carryover.md` shows phase-01 through phase-04 under "Completed". Confirm the scope paths exist. If pre-state is inconsistent, stop and report.
2. **Run the test commands below to establish a green baseline.** If the baseline is not green, stop and report.
3. **Apply the `simplify` skill to the scope paths**, honoring every established pattern from carryover's "Established patterns" section (in particular per-service idioms captured in phases 03 and 04) and every Hard Constraint above.
4. **Run the test commands below again.** If anything regressed, address it inside this phase before proceeding.
5. **Update `tmp/tasks/simplify/carryover.md`** per the schema:
    - Move phase-05 from "Pending" to "Completed" with a one-paragraph summary of what changed.
    - Append any newly established patterns to "Established patterns".
    - Append the list of files materially changed to "Files modified by phase → phase-05".
    - Record the test-status snapshot under "Test status checkpoints → phase-05".
    - Append any deferred items to "Open / deferred".

## Test Commands
- Lint: `yarn lint`
- Unit: `yarn test:unit`
- E2E: `yarn test:e2e` (full reload — required because this phase touches `@MessagePattern` handlers, the cross-service confirm RPC adapter, and event publishers)

## Exit Criteria
- `[ ]` `simplify` skill applied to every path under `scope_paths`.
- `[ ]` `yarn lint` passes with `--max-warnings 0`.
- `[ ]` `yarn test:unit` passes.
- `[ ]` `yarn test:e2e` passes.
- `[ ]` `tmp/tasks/simplify/carryover.md` updated per §Procedure step 5.
- `[ ]` No new files outside `tmp/tasks/simplify/` other than in-place code modifications.
- `[ ]` No comment, marker, or documentation entry in the codebase mentions this pass.
- `[ ]` Nothing under `tmp/` deleted, moved, or renamed.
- `[ ]` `ClientProxy` (from `@nestjs/microservices`) appears only inside `apps/retail-microservice/src/modules/orders/infrastructure/messaging/*.ts`.
- `[ ]` No file under `apps/retail-microservice/src/modules/orders/application/` imports `@nestjs/typeorm` or bare `typeorm`.
- `[ ]` `main.ts` still imports `@retail-inventory-system/observability/tracer` first.

## On Failure
If any step fails irrecoverably within this phase's scope, stop, leave the repository in a clean state (revert partial diffs if needed), record the failure under "Open / deferred" in the carryover document with enough detail for a human to triage (which file, which test failed, the skill's last-attempted intent), and exit without marking the phase completed.
