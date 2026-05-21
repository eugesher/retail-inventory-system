---
id: phase-04
title: Inventory microservice
depends_on: [phase-03]
scope_paths:
  - apps/inventory-microservice/**
estimated_files: 42
---

# Phase 04 — Inventory microservice

## Goal
Apply the `simplify` skill to the inventory microservice — single `stock` bounded context per ADR-012. Scope covers `apps/inventory-microservice/src/{app,main.ts,modules/stock}` including domain (StockItem aggregate with quantity / reservedQuantity invariants, Storage VO, StockReservedEvent, StockReleasedEvent, StockLowEvent), application (`IStockRepositoryPort`, `IStockCachePort`, `IStockEventsPublisherPort`, `ITransactionPort`, plus `GetStockUseCase`, `ReserveStockForOrderUseCase`, `AddStockUseCase`), infrastructure (TypeORM entities + mapper + repository + `TypeormTransactionAdapter`, `StockCache` cache adapter, `StockRabbitmqPublisher`), and presentation (`StockController` with `@MessagePattern` handlers for `inventory.product-stock.get` and `inventory.order.confirm`). Observable outcome: smaller per-file footprint with port surfaces preserved and the spec siblings (near 1:1 LOC ratio) kept consistent with their production-code partners.

## You Are Running In a Clean Context
This task file is everything you have. There is no prior memory of earlier phases. You must:

1. **Read** `tmp/tasks/simplify/carryover.md` in full before doing anything else. It contains established patterns from earlier phases that you must apply consistently — phase-03 ran the same kind of work on the notification microservice and will have left a per-service convention sketch.
2. **Read** only the files under "Pre-read" below from `docs/adr/` and the repository.
3. **Do not** read `tmp/tasks/simplify/00-plan.md` or any other phase file — they are not part of your context.

## Pre-read
- `tmp/tasks/simplify/carryover.md` (full).
- `docs/adr/004-adopt-hexagonal-architecture-per-service.md` — per-module hexagonal layout.
- `docs/adr/012-stock-aggregate-and-port-adapter.md` — reshapes inventory to single `stock` bounded context; defines the three port symbols.
- `docs/adr/002-redis-cache-aside-product-stock.md` — cache-aside contract (preserved verbatim through the migration).
- `docs/adr/016-cache-aside-generalized.md` — `CACHE_KEYS.inventoryStock*` builders; `delByPrefix`.
- `docs/adr/021-cache-single-flight-and-ttl-jitter.md` — `singleFlight` + ±10% jitter on `StockCache.set`.
- `docs/adr/022-cache-keys-tenant-and-schema-version.md` — `INVENTORY_STOCK_KEY_VERSION` constant; opt-in `t:<tenantId>` segment.
- `docs/adr/023-cache-invalidate-post-commit-by-type.md` — `IStockCachePort.withInvalidation(work, resolveItems, opts)`; no public `invalidate`; type-enforced post-commit ordering.
- `docs/adr/019-typeorm-and-mysql-for-persistence.md` — TypeORM + MySQL; `BaseEntity` ID strategy.
- `docs/adr/017-architecture-lint-via-eslint-boundaries.md` — boundaries rules are authoritative; `yarn lint` is the source of truth.
- `docs/audits/audit-2026-05-20-followup.md` — multiple `still-relevant` issues in the stock module reference specific line ranges with `AUDIT-2026-05-08 [...]` annotations that must be preserved.
- Repository files in `scope_paths` above.

## Hard Constraints
Restate these in full — do not link out:

- **ADRs are immutable.** This phase must not steer the `simplify` skill toward changes that contradict ADR-002, ADR-004, ADR-012, ADR-016, ADR-017, ADR-019, ADR-021, ADR-022, ADR-023. In particular:
  - **Per-module hexagonal layout is preserved** — `domain/`, `application/{ports,use-cases}/`, `infrastructure/{cache,messaging,persistence}/`, `presentation/`.
  - **Port DI symbols are frozen**: `STOCK_REPOSITORY`, `STOCK_CACHE`, `STOCK_EVENTS_PUBLISHER`, `TRANSACTION_PORT`. None may be renamed.
  - **`IStockCachePort` surface**: `get` returns the `{ value, available }` shape (CACHE-005 resolution); the only write path is `withInvalidation(work, resolveItems, opts)`. **There is no public `invalidate` method** — this is type-enforced post-commit ordering per ADR-023. Do not reintroduce it.
  - **`getOrLoad` wraps the miss path in `ICachePort.singleFlight`** (ADR-021). The leader runs the loader and writes back; followers reuse the leader's result; ±10% TTL jitter applies on write-back. Preserve this pattern verbatim.
  - **Cache keys go through `CACHE_KEYS.inventoryStock*`** builders only — no string-literal cache keys anywhere under `apps/inventory-microservice/src`. Apps must not import `@nestjs/cache-manager`, `@keyv/redis`, or the `cacheable` package directly.
  - **The opaque transaction port** (`ITransactionPort` + `ITransactionScope`) is the only way the application layer reaches a transactional boundary. The TypeORM downcast lives in `TypeormTransactionAdapter` and `StockTypeormRepository` only. The application layer must not import `@nestjs/typeorm` or bare `typeorm` — enforced by ESLint boundaries (ADR-017 §4); do not weaken a rule to make code pass.
  - **`@MessagePattern('inventory.product-stock.get')` and `@MessagePattern('inventory.order.confirm')`** keep their pattern strings — they are the wire format. The routing-key constants live in `libs/messaging` (out of scope this phase); do not introduce literal pattern strings that diverge from the constants.
  - **`StockRabbitmqPublisher` emits `inventory.stock.low`** when post-commit `(productId, storageId)` quantity is at-or-below `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD` (a constant in `libs/contracts/inventory`). Do not break this emission.
  - **Domain code is framework-free** — files under `apps/inventory-microservice/src/modules/stock/domain/` must not import `@nestjs/*`, `@retail-inventory-system/messaging`, `…/cache`, `…/observability`, `…/database`, or `typeorm`.
  - **`main.ts` imports `@retail-inventory-system/observability/tracer` first.**
- **Behavior preservation.** Test suites listed under "Test commands" below must pass after this phase. If `simplify` removes code covered only by tests that become trivial, those tests may be removed; meaningful coverage may not be. Inventory has near-1:1 spec/prod LOC ratio — spec siblings under `…/spec/` ARE part of this phase's scope and may be simplified alongside their production-code partners.
- **No artifacts in the code.** Do not add any comment, marker, file, or `README.md`/`CLAUDE.md` entry describing this pass. Do not append to any ADR.
- **Preserve audit annotations.** The block at `reserve-stock-for-order.use-case.ts` carrying `AUDIT-2026-05-08 [CODE-001]` (the thirteen-line forward-looking-NULL-storage comment block around the `!!item.storageId` filter), the annotation at `get-stock.use-case.ts` carrying `AUDIT-2026-05-08 [CACHE-001]`, and any other `AUDIT-...` markers must not be deleted. They are load-bearing breadcrumbs to the 2026-05-20 follow-up audit. Stale notes (e.g. the CACHE-006 mention in `stock.cache.ts` flagged in the audit's verification section) are still in scope for the audit record and must remain.
- **No deletion under `tmp/`.** Do not delete, move, or rename anything under `tmp/`.
- **No files outside `tmp/tasks/simplify/`** other than in-place code modifications produced by the skill.
- **Out of scope, always**: `migrations/**`, `tests/lint/architecture-lint.spec.ts`, `tmp/**`, `dist/**`, `coverage/**`, `node_modules/**`, root-level `task.md` / `todo.md` / `nvim.md` / `http.md` / `a.md`, `docs/**`, `README.md`, `CLAUDE.md`, ADRs, `package.json`, `tsconfig.json`, ESLint / Prettier config files, `docker-compose*.yml`, `Dockerfile`. Also out of scope this phase: all of `libs/**`, `apps/api-gateway/**`, `apps/notification-microservice/**`, `apps/retail-microservice/**`, `test/**`, `scripts/**`.
- **Idempotency.** If `carryover.md` shows this phase as completed under "Phase ledger → Completed", verify the repository state matches and exit. If partially completed, resume from the documented state.

## Procedure

1. **Verify entry state.** Confirm `carryover.md` shows phase-01, phase-02, and phase-03 under "Completed". Confirm the scope paths exist. If pre-state is inconsistent, stop and report.
2. **Run the test commands below to establish a green baseline.** If the baseline is not green, stop and report.
3. **Apply the `simplify` skill to the scope paths**, honoring every established pattern from carryover's "Established patterns" section (in particular any per-service idioms captured in phase-03) and every Hard Constraint above.
4. **Run the test commands below again.** If anything regressed, address it inside this phase before proceeding.
5. **Update `tmp/tasks/simplify/carryover.md`** per the schema:
    - Move phase-04 from "Pending" to "Completed" with a one-paragraph summary of what changed.
    - Append any newly established patterns to "Established patterns".
    - Append the list of files materially changed to "Files modified by phase → phase-04".
    - Record the test-status snapshot under "Test status checkpoints → phase-04".
    - Append any deferred items to "Open / deferred".

## Test Commands
- Lint: `yarn lint`
- Unit: `yarn test:unit`
- E2E: `yarn test:e2e` (full reload — required because this phase touches `@MessagePattern` handlers and the cache adapter)

## Exit Criteria
- `[ ]` `simplify` skill applied to every path under `scope_paths`.
- `[ ]` `yarn lint` passes with `--max-warnings 0`.
- `[ ]` `yarn test:unit` passes.
- `[ ]` `yarn test:e2e` passes.
- `[ ]` `tmp/tasks/simplify/carryover.md` updated per §Procedure step 5.
- `[ ]` No new files outside `tmp/tasks/simplify/` other than in-place code modifications.
- `[ ]` No comment, marker, or documentation entry in the codebase mentions this pass.
- `[ ]` Nothing under `tmp/` deleted, moved, or renamed.
- `[ ]` `IStockCachePort` still has no public `invalidate`; `withInvalidation` remains the only write-path entry.
- `[ ]` No file under `apps/inventory-microservice/src` contains a cache-key string literal (only `CACHE_KEYS.*` builder calls).
- `[ ]` No file under `apps/inventory-microservice/src/modules/stock/application/` imports `@nestjs/typeorm` or bare `typeorm`.
- `[ ]` `main.ts` still imports `@retail-inventory-system/observability/tracer` first.
- `[ ]` All `AUDIT-...` annotation lines flagged in the 2026-05-20 follow-up audit remain present.

## On Failure
If any step fails irrecoverably within this phase's scope, stop, leave the repository in a clean state (revert partial diffs if needed), record the failure under "Open / deferred" in the carryover document with enough detail for a human to triage (which file, which test failed, the skill's last-attempted intent), and exit without marking the phase completed.
