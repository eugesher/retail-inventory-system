---
id: phase-03
title: Notification microservice
depends_on: [phase-02]
scope_paths:
  - apps/notification-microservice/**
estimated_files: 25
---

# Phase 03 — Notification microservice

## Goal
Apply the `simplify` skill to the notification microservice — the smallest, RMQ-only consumer service and the canonical per-module hexagonal template (per ADR-011). Scope covers `apps/notification-microservice/src/{app,main.ts,modules/notifications}` including domain (Notification value object, NotificationChannelEnum), application (`INotifierPort` + `NOTIFIER` symbol, `SendOrderNotificationUseCase`, `SendLowStockAlertUseCase`), infrastructure (consumers for `retail.order.created` / `inventory.stock.low`; delivery adapters for log/email/webhook), and presentation (`HealthController`). Observable outcome: smaller per-file footprint while preserving the canonical-template shape that downstream phases will mirror.

## You Are Running In a Clean Context
This task file is everything you have. There is no prior memory of earlier phases. You must:

1. **Read** `tmp/tasks/simplify/carryover.md` in full before doing anything else. It contains established patterns from earlier phases that you must apply consistently.
2. **Read** only the files under "Pre-read" below from `docs/adr/` and the repository.
3. **Do not** read `tmp/tasks/simplify/00-plan.md` or any other phase file — they are not part of your context.

## Pre-read
- `tmp/tasks/simplify/carryover.md` (full).
- `docs/adr/004-adopt-hexagonal-architecture-per-service.md` — per-module hexagonal layout binding every service.
- `docs/adr/011-notifier-port-and-adapters.md` — establishes notification as the canonical per-module template; ports outbound delivery behind `NOTIFIER`.
- `docs/adr/008-rabbitmq-via-libs-messaging.md` — dotted `ROUTING_KEYS`; `retail.order.created` and `inventory.stock.low` are the two routing keys this service consumes.
- `docs/adr/017-architecture-lint-via-eslint-boundaries.md` — boundaries rules are authoritative; `yarn lint` is the source of truth.
- Repository files in `scope_paths` above.

## Hard Constraints
Restate these in full — do not link out:

- **ADRs are immutable.** This phase must not steer the `simplify` skill toward changes that contradict ADR-004, ADR-008, ADR-011, ADR-017, ADR-018, ADR-020. In particular:
  - **Per-module hexagonal layout is preserved**: `domain/`, `application/{ports,use-cases}/`, `infrastructure/{consumers,delivery}/`, `presentation/` remain the canonical sub-folders.
  - **`INotifierPort` + `NOTIFIER` DI symbol** keep their names. The `LogNotifierAdapter` remains the default binding; `EmailNotifierAdapter` and `WebhookNotifierAdapter` remain as future swap-in adapters and must not be deleted as "unused" — they are deliberate placeholders documented in ADR-011.
  - **Consumer routing-key strings must not be renamed** — `retail.order.created` and `inventory.stock.low` are wire format, owned by `ROUTING_KEYS` in `libs/messaging` (out of scope this phase). The notification consumers reference these constants; the consumers may move within the file but the routing-key reference must remain.
  - **`@MessagePattern('notification.health.ping')`** on the `HealthController` keeps its pattern string — it's the RMQ-transport health-check probe.
  - **`main.ts` imports `@retail-inventory-system/observability/tracer` first** — auto-instrumentation patches happen at module load. Do not reorder.
  - **Framework-free domain.** Files under `apps/notification-microservice/src/modules/notifications/domain/` must not import `@nestjs/*`, `@retail-inventory-system/messaging`, `…/cache`, `…/observability`, `…/database`, or `typeorm`. Enforced by ESLint boundaries; do not weaken a rule to make code pass.
- **Behavior preservation.** Test suites listed under "Test commands" below must pass after this phase. If `simplify` removes code covered only by tests that become trivial, those tests may be removed; meaningful coverage may not be.
- **The notification spec layout is intentionally different** — the class-based `FakeLogger` and hand-rolled `InMemoryNotifier` test doubles fit its no-DB / no-RPC shape. Do not converge this spec style to the inventory/retail "plain-object `LoggerMock` + `jest.Mocked<Pick<...>>`" pattern; the 2026-05-20 follow-up audit (DOCS-001) explicitly documents the divergence as meaningful design, not drift.
- **No artifacts in the code.** Do not add any comment, marker, file, or `README.md`/`CLAUDE.md` entry describing this pass. Do not append to any ADR.
- **Preserve audit annotations.** Lines tagged `AUDIT-2026-05-08 [...]` and `AUDIT-2026-05-20 [...]` must not be deleted.
- **No deletion under `tmp/`.** Do not delete, move, or rename anything under `tmp/`.
- **No files outside `tmp/tasks/simplify/`** other than in-place code modifications produced by the skill.
- **Out of scope, always**: `migrations/**`, `tests/lint/architecture-lint.spec.ts`, `tmp/**`, `dist/**`, `coverage/**`, `node_modules/**`, root-level `task.md` / `todo.md` / `nvim.md` / `http.md` / `a.md`, `docs/**`, `README.md`, `CLAUDE.md`, ADRs, `package.json`, `tsconfig.json`, ESLint / Prettier config files, `docker-compose*.yml`, `Dockerfile`. Also out of scope this phase: all of `libs/**`, `apps/api-gateway/**`, `apps/inventory-microservice/**`, `apps/retail-microservice/**`, `test/**`, `scripts/**`.
- **Idempotency.** If `carryover.md` shows this phase as completed under "Phase ledger → Completed", verify the repository state matches and exit. If partially completed, resume from the documented state.

## Procedure

1. **Verify entry state.** Confirm `carryover.md` shows phase-01 and phase-02 under "Completed". Confirm the scope paths exist. If pre-state is inconsistent, stop and report.
2. **Run the test commands below to establish a green baseline.** If the baseline is not green, stop and report.
3. **Apply the `simplify` skill to the scope paths**, honoring every established pattern from carryover's "Established patterns" section and every Hard Constraint above. The skill should produce uniform style across the notification module; downstream service phases will mirror the shape.
4. **Run the test commands below again.** If anything regressed, address it inside this phase before proceeding.
5. **Update `tmp/tasks/simplify/carryover.md`** per the schema:
    - Move phase-03 from "Pending" to "Completed" with a one-paragraph summary of what changed.
    - Append any newly established patterns to "Established patterns" — this is the first per-service phase, so cross-service conventions captured here will guide phases 04–06.
    - Append the list of files materially changed to "Files modified by phase → phase-03".
    - Record the test-status snapshot under "Test status checkpoints → phase-03".
    - Append any deferred items to "Open / deferred".

## Test Commands
- Lint: `yarn lint`
- Unit: `yarn test:unit`
- E2E: `yarn test:e2e` (full reload — required because this phase touches `@EventPattern` consumers and the RMQ wire interface)

## Exit Criteria
- `[ ]` `simplify` skill applied to every path under `scope_paths`.
- `[ ]` `yarn lint` passes with `--max-warnings 0`.
- `[ ]` `yarn test:unit` passes.
- `[ ]` `yarn test:e2e` passes.
- `[ ]` `tmp/tasks/simplify/carryover.md` updated per §Procedure step 5.
- `[ ]` No new files outside `tmp/tasks/simplify/` other than in-place code modifications.
- `[ ]` No comment, marker, or documentation entry in the codebase mentions this pass.
- `[ ]` Nothing under `tmp/` deleted, moved, or renamed.
- `[ ]` `EmailNotifierAdapter` and `WebhookNotifierAdapter` files still exist.
- `[ ]` `main.ts` still imports `@retail-inventory-system/observability/tracer` first.

## On Failure
If any step fails irrecoverably within this phase's scope, stop, leave the repository in a clean state (revert partial diffs if needed), record the failure under "Open / deferred" in the carryover document with enough detail for a human to triage (which file, which test failed, the skill's last-attempted intent), and exit without marking the phase completed.
