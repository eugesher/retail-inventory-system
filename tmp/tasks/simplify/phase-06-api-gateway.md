---
id: phase-06
title: API gateway
depends_on: [phase-05]
scope_paths:
  - apps/api-gateway/**
estimated_files: 64
---

# Phase 06 — API gateway

## Goal
Apply the `simplify` skill to the API gateway — the HTTP entry point (port 3000). Scope covers `apps/api-gateway/src/{app,main.ts,common/utils,modules/{auth,inventory,retail}}`. Three modules live here:

- **`modules/auth/`** — the only gateway module with a real `domain/` (User aggregate, RoleVO, UserRegistered / UserLoggedIn events) and the only owner of DB state in the gateway. Use cases: Login, Refresh, Logout, Register, ValidateUser. Adapters: `UserTypeormRepository`, `JwtTokenAdapter`, `Argon2PasswordAdapter`. Presentation: `AuthController` + `AuthAdminController`.
- **`modules/retail/`** — port-and-adapter shell calling the retail microservice (`RETAIL_GATEWAY_PORT` + `RetailRabbitmqAdapter`); use cases `CreateOrderUseCase`, `ConfirmOrderUseCase`; presentation `OrderController` + `OrderConfirmPipe`.
- **`modules/inventory/`** — port-and-adapter shell calling the inventory microservice (`INVENTORY_GATEWAY_PORT` + `InventoryRabbitmqAdapter`); use case `GetProductStockUseCase`; presentation `ProductController`.

Observable outcome: smaller per-file footprint with the auth pipeline (HS256 JWT + argon2id + rotated refresh) and the global guard wiring intact.

## You Are Running In a Clean Context
This task file is everything you have. There is no prior memory of earlier phases. You must:

1. **Read** `tmp/tasks/simplify/carryover.md` in full before doing anything else. It contains established patterns from earlier phases that you must apply consistently.
2. **Read** only the files under "Pre-read" below from `docs/adr/` and the repository.
3. **Do not** read `tmp/tasks/simplify/00-plan.md` or any other phase file — they are not part of your context.

## Pre-read
- `tmp/tasks/simplify/carryover.md` (full).
- `docs/adr/004-adopt-hexagonal-architecture-per-service.md` — per-module hexagonal layout.
- `docs/adr/009-port-adapter-at-the-gateway.md` — gateway per-module hexagonal; `ClientProxy` confined to `infrastructure/messaging/*-rabbitmq.{adapter,publisher}.ts`.
- `docs/adr/010-jwt-rbac-at-the-gateway.md` — HS256 JWT + argon2id + rotated refresh w/ reuse detection; global `JwtAuthGuard` + `RolesGuard` via `APP_GUARD`; `@Public`, `@Roles`, `@CurrentUser`; argon2id cost defaults (`AUTH_ARGON2_*` env).
- `docs/adr/008-rabbitmq-via-libs-messaging.md` — dotted `ROUTING_KEYS`; gateway adapters reference the constants, not literal pattern strings.
- `docs/adr/019-typeorm-and-mysql-for-persistence.md` — TypeORM + MySQL; only `auth` owns DB state in the gateway.
- `docs/adr/017-architecture-lint-via-eslint-boundaries.md` — boundaries rules are authoritative; `yarn lint` is the source of truth.
- Repository files in `scope_paths` above.

## Hard Constraints
Restate these in full — do not link out:

- **ADRs are immutable.** This phase must not steer the `simplify` skill toward changes that contradict ADR-004, ADR-008, ADR-009, ADR-010, ADR-017, ADR-018, ADR-019, ADR-020. In particular:
  - **Per-module hexagonal layout is preserved** in each of `modules/{auth,retail,inventory}/`.
  - **`ClientProxy` boundary**: `ClientProxy` from `@nestjs/microservices` is allowed only inside `apps/api-gateway/src/modules/{retail,inventory}/infrastructure/messaging/*-rabbitmq.adapter.ts`. Controllers, use-cases, and pipes inject the port symbol (`RETAIL_GATEWAY_PORT` / `INVENTORY_GATEWAY_PORT`). Adapters use `ROUTING_KEYS` from `@retail-inventory-system/messaging` (not the legacy `MicroserviceMessagePatternEnum`).
  - **Auth defaults (ADR-010)**:
    - HS256 JWTs; refresh tokens rotated on every successful refresh, with a hash of the live token persisted on the user row; reuse of a stale refresh token clears the live hash and returns 401. Preserve this state-machine.
    - Passwords are hashed with **argon2id** at the OWASP 2024 cost defaults (19,456 KiB memory, 2 iterations, 1 thread; tunable via `AUTH_ARGON2_*` env). Preserve the env-driven tunability.
  - **Global guards via `APP_GUARD`**: `JwtAuthGuard` and `RolesGuard` are wired in `app.module.ts` via `APP_GUARD`. Every HTTP route is protected by default; `@Public()` opts out; `@Roles(RoleEnum.X, …)` authorizes; `@CurrentUser()` injects the authenticated user. Do not introduce a per-controller guard pattern that contradicts the global wiring.
  - **`AuthModule.forRootAsync({ imports, providers, exports })`** binds `AUTH_USER_VALIDATOR` → `ValidateUserUseCase`. Preserve the binding.
  - **`auth` is the only gateway module with a `domain/`** — User aggregate, RoleVO, UserRegistered / UserLoggedIn events. `retail` and `inventory` modules at the gateway are intentionally domain-less port shells (per ADR-009). Do not create a `domain/` folder under `modules/retail/` or `modules/inventory/`.
  - **DTOs in the auth presentation layer use class-validator + Swagger decorators** — preserve this for the auth controllers (Login / Refresh / Token / CurrentUser DTOs).
  - **Domain code is framework-free** — files under `apps/api-gateway/src/modules/auth/domain/` must not import `@nestjs/*`, `@retail-inventory-system/messaging`, `…/cache`, `…/observability`, `…/database`, or `typeorm`.
  - **The application layer must not import `@nestjs/typeorm` or bare `typeorm`** — enforced by ESLint boundaries (ADR-017 §4); do not weaken a rule to make code pass.
  - **`main.ts` imports `@retail-inventory-system/observability/tracer` first.**
- **Behavior preservation.** Test suites listed under "Test commands" below must pass after this phase. If `simplify` removes code covered only by tests that become trivial, those tests may be removed; meaningful coverage may not be.
- **No artifacts in the code.** Do not add any comment, marker, file, or `README.md`/`CLAUDE.md` entry describing this pass. Do not append to any ADR.
- **Preserve audit annotations.** Lines tagged `AUDIT-2026-05-08 [...]` and `AUDIT-2026-05-20 [...]` must not be deleted.
- **No deletion under `tmp/`.** Do not delete, move, or rename anything under `tmp/`.
- **No files outside `tmp/tasks/simplify/`** other than in-place code modifications produced by the skill.
- **Out of scope, always**: `migrations/**`, `tests/lint/architecture-lint.spec.ts`, `tmp/**`, `dist/**`, `coverage/**`, `node_modules/**`, root-level `task.md` / `todo.md` / `nvim.md` / `http.md` / `a.md`, `docs/**`, `README.md`, `CLAUDE.md`, ADRs, `package.json`, `tsconfig.json`, ESLint / Prettier config files, `docker-compose*.yml`, `Dockerfile`. Also out of scope this phase: all of `libs/**`, `apps/inventory-microservice/**`, `apps/notification-microservice/**`, `apps/retail-microservice/**`, `test/**`, `scripts/**`.
- **Idempotency.** If `carryover.md` shows this phase as completed under "Phase ledger → Completed", verify the repository state matches and exit. If partially completed, resume from the documented state.

## Procedure

1. **Verify entry state.** Confirm `carryover.md` shows phase-01 through phase-05 under "Completed". Confirm the scope paths exist. If pre-state is inconsistent, stop and report.
2. **Run the test commands below to establish a green baseline.** If the baseline is not green, stop and report.
3. **Apply the `simplify` skill to the scope paths**, honoring every established pattern from carryover's "Established patterns" section and every Hard Constraint above. The three gateway modules (`auth`, `retail`, `inventory`) are independent sub-scopes; the skill may converge to different idioms in each, but should produce a uniform style within each.
4. **Run the test commands below again.** If anything regressed, address it inside this phase before proceeding.
5. **Update `tmp/tasks/simplify/carryover.md`** per the schema:
    - Move phase-06 from "Pending" to "Completed" with a one-paragraph summary of what changed.
    - Append any newly established patterns to "Established patterns".
    - Append the list of files materially changed to "Files modified by phase → phase-06".
    - Record the test-status snapshot under "Test status checkpoints → phase-06".
    - Append any deferred items to "Open / deferred".

## Test Commands
- Lint: `yarn lint`
- Unit: `yarn test:unit`
- E2E: `yarn test:e2e` (full reload — required because this phase touches HTTP controllers, the auth pipeline, and gateway-side RMQ adapters; the e2e specs `test/auth.e2e-spec.ts` and `test/system-api.e2e-spec.ts` exercise the gateway end-to-end)

## Exit Criteria
- `[ ]` `simplify` skill applied to every path under `scope_paths`.
- `[ ]` `yarn lint` passes with `--max-warnings 0`.
- `[ ]` `yarn test:unit` passes.
- `[ ]` `yarn test:e2e` passes.
- `[ ]` `tmp/tasks/simplify/carryover.md` updated per §Procedure step 5.
- `[ ]` No new files outside `tmp/tasks/simplify/` other than in-place code modifications.
- `[ ]` No comment, marker, or documentation entry in the codebase mentions this pass.
- `[ ]` Nothing under `tmp/` deleted, moved, or renamed.
- `[ ]` `ClientProxy` (from `@nestjs/microservices`) appears only inside `apps/api-gateway/src/modules/{retail,inventory}/infrastructure/messaging/*.ts`.
- `[ ]` `JwtAuthGuard` and `RolesGuard` are still wired via `APP_GUARD` in `apps/api-gateway/src/app/app.module.ts`.
- `[ ]` No `domain/` folder exists under `apps/api-gateway/src/modules/retail/` or `apps/api-gateway/src/modules/inventory/`.
- `[ ]` `main.ts` still imports `@retail-inventory-system/observability/tracer` first.

## On Failure
If any step fails irrecoverably within this phase's scope, stop, leave the repository in a clean state (revert partial diffs if needed), record the failure under "Open / deferred" in the carryover document with enough detail for a human to triage (which module, which file, which test failed, the skill's last-attempted intent), and exit without marking the phase completed.
