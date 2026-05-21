---
id: phase-01
title: Foundational libs
depends_on: []
scope_paths:
  - libs/common/**
  - libs/contracts/**
  - libs/ddd/**
  - libs/config/**
  - libs/database/**
estimated_files: 60
---

# Phase 01 — Foundational libs

## Goal
Apply the `simplify` skill to the five foundational libraries: `libs/common` (Result, DomainException, pagination types, utility types), `libs/contracts` (cross-service message and DTO contracts — sub-areas `microservices/`, `retail/`, `inventory/`, `auth/`), `libs/ddd` (Entity / AggregateRoot / ValueObject / DomainEvent / IRepositoryPort building blocks), `libs/config` (Joi env schema in `configModuleConfig`), and `libs/database` (BaseEntity, BaseTypeormRepository, SnakeNamingStrategy, DatabaseModule). Observable outcome: smaller, more uniform foundational surface, with every exported **type name, field name, enum member, and DI symbol preserved exactly** — these are the cross-service ABI on which every downstream phase depends.

## You Are Running In a Clean Context
This task file is everything you have. There is no prior memory of earlier phases. You must:

1. **Read** `tmp/tasks/simplify/carryover.md` in full before doing anything else. It contains established patterns from earlier phases that you must apply consistently.
2. **Read** only the files under "Pre-read" below from `docs/adr/` and the repository.
3. **Do not** read `tmp/tasks/simplify/00-plan.md` or any other phase file — they are not part of your context.

## Pre-read
- `tmp/tasks/simplify/carryover.md` (full).
- `docs/adr/005-split-shared-common-into-bounded-libs.md` — defines what each of these libs is allowed to contain.
- `docs/adr/018-nestjs-monorepo-apps-and-libs.md` — locks the apps-plus-libs monorepo shape.
- `docs/adr/019-typeorm-and-mysql-for-persistence.md` — locks `BaseEntity` / `SnakeNamingStrategy` / `BaseTypeormRepository`.
- `docs/adr/008-rabbitmq-via-libs-messaging.md` — `libs/contracts/microservices` carries the queue/pattern/token/app-name enums referenced by routing-key wiring.
- `docs/adr/010-jwt-rbac-at-the-gateway.md` — `libs/contracts/auth` carries `RoleEnum`, `ICurrentUser`, and the JWT payload interfaces.
- Repository files in `scope_paths` above.

## Hard Constraints
Restate these in full — do not link out:

- **ADRs are immutable.** This phase must not steer the `simplify` skill toward changes that contradict ADR-005, ADR-008, ADR-010, ADR-017, ADR-018, ADR-019. In particular:
  - **No type, field, enum member, or DI symbol exported from `libs/contracts` may be renamed.** These are the cross-service ABI. Internal shape changes inside a file are fine; the public name surface is frozen for this phase.
  - **No re-org of `libs/common` back into the pre-ADR-005 grab-bag.** The sub-areas `exceptions/`, `pagination/`, `types/` stay.
  - **`BaseEntity`, `BaseTypeormRepository`, `SnakeNamingStrategy`, `DatabaseModule.forRoot`, `DatabaseModule.forFeature`** keep their public surface.
  - **`configModuleConfig`** keeps its public surface — apps and tests import it by name.
  - **Framework-free constraint** on `libs/ddd` and `libs/common`: no `@nestjs/*`, no `typeorm`, no `@retail-inventory-system/messaging`, no `…/cache`, no `…/observability`, no `…/database` imports may be introduced.
- **Behavior preservation.** Test suites listed under "Test commands" below must pass after this phase. If `simplify` removes code covered only by tests that become trivial, those tests may be removed; meaningful coverage may not be.
- **No artifacts in the code.** Do not add any comment, marker, file, or `README.md`/`CLAUDE.md` entry describing this pass. Do not append to any ADR. The only observable change to the repository is the simplifications themselves.
- **Preserve audit annotations.** Lines tagged `AUDIT-2026-05-08 [...]` are load-bearing breadcrumbs to the 2026-05-20 follow-up audit and must not be deleted.
- **Preserve dual routing-key registries.** The legacy `MicroserviceMessagePatternEnum` in `libs/contracts/microservices/microservice-message-pattern.enum.ts` co-exists with the dotted `ROUTING_KEYS` (which live in `libs/messaging`, out of scope this phase). Do not delete the legacy enum.
- **No deletion under `tmp/`.** Do not delete, move, or rename anything under `tmp/`.
- **No files outside `tmp/tasks/simplify/`** other than in-place code modifications produced by the skill.
- **Out of scope, always**: `migrations/**`, `tests/lint/architecture-lint.spec.ts`, `tmp/**`, `dist/**`, `coverage/**`, `node_modules/**`, root-level `task.md` / `todo.md` / `nvim.md` / `http.md` / `a.md`, `docs/**`, `README.md`, `CLAUDE.md`, ADRs, `package.json`, `tsconfig.json`, ESLint / Prettier config files, `docker-compose*.yml`, `Dockerfile`.
- **Idempotency.** If `carryover.md` already shows this phase as completed under "Phase ledger → Completed", verify the repository state matches (no unexpected drift in `libs/{common,contracts,ddd,config,database}`) and exit without further changes. If partially completed (the phase appears under "Completed" with notes of failure, or the "Files modified by phase → phase-01" list is non-empty but the ledger shows it Pending), resume from the documented state.

## Procedure

1. **Verify entry state.** This phase has no `depends_on`. Confirm the scope paths exist. Confirm `carryover.md` shows phase-01 under "Pending" or as a partial under "Files modified by phase → phase-01". If pre-state is inconsistent, stop and report.
2. **Run the test commands below to establish a green baseline.** If the baseline is not green, stop and report — do not proceed with simplification on top of a broken suite.
3. **Apply the `simplify` skill to the scope paths**, honoring every established pattern from carryover's "Established patterns" section and every Hard Constraint above. Treat the five libs as independent sub-scopes; the skill may converge to different idioms in each, but should produce a uniform style within each lib.
4. **Run the test commands below again.** If anything regressed, address it inside this phase before proceeding. If you cannot bring tests back to green within the skill's contract, stop and report.
5. **Update `tmp/tasks/simplify/carryover.md`** per the schema:
    - Move phase-01 from "Pending" to "Completed" with a one-paragraph summary of what changed.
    - Append any newly established patterns to "Established patterns" (cross-phase conventions worth applying consistently — file layout, naming, idiom choices the skill converged on).
    - Append the list of files materially changed to "Files modified by phase → phase-01".
    - Record the test-status snapshot under "Test status checkpoints → phase-01".
    - Append any deferred items to "Open / deferred".

## Test Commands
- Lint: `yarn lint`
- Unit: `yarn test:unit`
- E2E: _Not required for this phase._ These libs are pure types / Joi schema / TypeORM base classes; they have no wire-format or DB-state surface that e2e would exercise distinctly. Unit + lint is the correct granularity.

## Exit Criteria
- `[ ]` `simplify` skill applied to every path under `scope_paths`.
- `[ ]` `yarn lint` passes with `--max-warnings 0`.
- `[ ]` `yarn test:unit` passes.
- `[ ]` `tmp/tasks/simplify/carryover.md` updated per §Procedure step 5.
- `[ ]` No new files outside `tmp/tasks/simplify/` other than in-place code modifications.
- `[ ]` No comment, marker, or documentation entry in the codebase mentions this pass.
- `[ ]` Nothing under `tmp/` deleted, moved, or renamed.
- `[ ]` No exported type / field / enum member / DI symbol name in `libs/contracts` has been renamed.

## On Failure
If any step fails irrecoverably within this phase's scope, stop, leave the repository in a clean state (revert partial diffs if needed), record the failure under "Open / deferred" in the carryover document with enough detail for a human to triage (which lib, which file, which test failed, the skill's last-attempted intent), and exit without marking the phase completed.
