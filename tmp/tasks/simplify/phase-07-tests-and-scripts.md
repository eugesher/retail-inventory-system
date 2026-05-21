---
id: phase-07
title: Tests and scripts
depends_on: [phase-06]
scope_paths:
  - test/**
  - scripts/**
estimated_files: 10
---

# Phase 07 — Tests and scripts

## Goal
Apply the `simplify` skill to the cross-cutting e2e test suite and the development scripts as the consolidating phase. Scope covers `test/{auth,notification,system-api}.e2e-spec.ts` (plus `test/__snapshots__/`, `test/jest.setup.ts`, `test/data-source/`), and `scripts/{migration-create.ts, test-db-seed.ts, utils/, bash/start-dev.sh, seeds/*.sql}`. Observable outcome: smaller, more uniform e2e and dev-script footprint, with the full e2e green at the end of the run.

## You Are Running In a Clean Context
This task file is everything you have. There is no prior memory of earlier phases. You must:

1. **Read** `tmp/tasks/simplify/carryover.md` in full before doing anything else. It contains established patterns from earlier phases that you must apply consistently.
2. **Read** only the files under "Pre-read" below from `docs/adr/` and the repository.
3. **Do not** read `tmp/tasks/simplify/00-plan.md` or any other phase file — they are not part of your context.

## Pre-read
- `tmp/tasks/simplify/carryover.md` (full).
- `docs/adr/001-structured-logging-with-pino.md` — Pino logger setup; `test/jest.setup.ts` installs a memory-backed Pino destination via `installMemoryPinoLogger()` (per the 2026-05-20 follow-up audit's TEST-002 resolution).
- `docs/adr/015-pino-trace-correlation.md` — `logMethod` hook on every log record.
- `docs/adr/019-typeorm-and-mysql-for-persistence.md` — TypeORM + MySQL migration workflow.
- `docs/adr/017-architecture-lint-via-eslint-boundaries.md` — boundaries rules are authoritative; `yarn lint` is the source of truth.
- `docs/audits/audit-2026-05-20-followup.md` — the still-relevant TEST-001 / TEST-002 / TEST-003 items reference specific locations in `test/system-api.e2e-spec.ts` and `test/jest.setup.ts`.
- Repository files in `scope_paths` above.

## Hard Constraints
Restate these in full — do not link out:

- **ADRs are immutable.** This phase must not steer the `simplify` skill toward changes that contradict ADR-001, ADR-015, ADR-017, ADR-019. In particular:
  - **`test/jest.setup.ts` calls `installMemoryPinoLogger()`** (from `@retail-inventory-system/observability/testing`) **before any spec import runs** — this is the only point at which `LoggerModuleConfig`'s constructor can see the memory destination (per ADR-001 + the 2026-05-20 follow-up audit TEST-002 resolution). Preserve the call site and its ordering invariant. Do not move it into a `beforeAll` hook.
  - **The three e2e bootstrap calls in `test/system-api.e2e-spec.ts`** (retail MS at ~L52, inventory MS at ~L67, api-gateway at ~L77) must NOT have `logger: false` reintroduced. The memory-backed Pino stream is the cache-hit side-channel that several assertions depend on.
  - **`tracer` side-effect import in any test bootstrap** must happen before the AppModule import, mirroring the production `main.ts` invariant.
  - **Snapshot assertions** (`toMatchSnapshot()` in `test/system-api.e2e-spec.ts`) may be augmented with explicit `toMatchObject` / field assertions but must NOT be wholesale removed. Snapshots are the comprehensive baseline; explicit assertions are additive tripwires (per the 2026-05-20 follow-up TEST-001 resolution).
  - **`scripts/migration-create.ts`** wraps the TypeORM CLI — the workflow (`yarn migration:create`) is part of ADR-019. Preserve the wrapper's behavior.
  - **`scripts/test-db-seed.ts` + `scripts/seeds/*.sql`** are wired into `yarn test:infra:reload`. Preserve the seed order and SQL file references.
  - **`scripts/bash/start-dev.sh`** is referenced by `yarn start:dev`. Preserve its entry-points (concurrently starting all four services).
- **Behavior preservation.** The full test commands listed below must pass after this phase. The e2e specs MUST end green — this is the consolidating phase, and a failure here means the simplification run did not converge.
- **No artifacts in the code.** Do not add any comment, marker, file, or `README.md`/`CLAUDE.md` entry describing this pass. Do not append to any ADR.
- **Preserve audit annotations.** Lines tagged `AUDIT-2026-05-08 [...]` and `AUDIT-2026-05-20 [...]` must not be deleted.
- **No deletion under `tmp/`.** Do not delete, move, or rename anything under `tmp/`.
- **No files outside `tmp/tasks/simplify/`** other than in-place code modifications produced by the skill.
- **Out of scope, always**: `migrations/**` (append-only ledger per ADR-019), `tests/lint/architecture-lint.spec.ts` (fixture-based regression bumper, deliberately verbose to mirror its ESLint config), `tmp/**`, `dist/**`, `coverage/**`, `node_modules/**`, root-level `task.md` / `todo.md` / `nvim.md` / `http.md` / `a.md`, `docs/**`, `README.md`, `CLAUDE.md`, ADRs, `package.json`, `tsconfig.json`, ESLint / Prettier config files, `docker-compose*.yml`, `Dockerfile`. Also out of scope this phase: all of `libs/**` and `apps/**`.
- **Idempotency.** If `carryover.md` shows this phase as completed under "Phase ledger → Completed", verify the repository state matches and exit. If partially completed, resume from the documented state.

## Procedure

1. **Verify entry state.** Confirm `carryover.md` shows phase-01 through phase-06 under "Completed". Confirm the scope paths exist. If pre-state is inconsistent, stop and report.
2. **Run the test commands below to establish a green baseline.** If the baseline is not green, stop and report — every earlier phase ended with green tests; a red baseline here implies drift between phases that needs human triage.
3. **Apply the `simplify` skill to the scope paths**, honoring every established pattern from carryover's "Established patterns" section and every Hard Constraint above.
4. **Run the test commands below again.** Because this is the consolidating phase, both unit and e2e must end green. If anything regressed, address it inside this phase before proceeding.
5. **Update `tmp/tasks/simplify/carryover.md`** per the schema:
    - Move phase-07 from "Pending" to "Completed" with a one-paragraph summary of what changed.
    - Append any newly established patterns to "Established patterns".
    - Append the list of files materially changed to "Files modified by phase → phase-07".
    - Record the test-status snapshot under "Test status checkpoints → phase-07".
    - Append any deferred items to "Open / deferred" (and note this is the final phase — any item still here is a human-triage tail).

## Test Commands
- Lint: `yarn lint`
- Unit: `yarn test:unit`
- E2E: `yarn test:e2e` (full reload — required, this is the consolidating run for the full simplification chain)

## Exit Criteria
- `[ ]` `simplify` skill applied to every path under `scope_paths`.
- `[ ]` `yarn lint` passes with `--max-warnings 0`.
- `[ ]` `yarn test:unit` passes.
- `[ ]` `yarn test:e2e` passes (full reload).
- `[ ]` `tmp/tasks/simplify/carryover.md` updated per §Procedure step 5.
- `[ ]` No new files outside `tmp/tasks/simplify/` other than in-place code modifications.
- `[ ]` No comment, marker, or documentation entry in the codebase mentions this pass.
- `[ ]` Nothing under `tmp/` deleted, moved, or renamed.
- `[ ]` `test/jest.setup.ts` still calls `installMemoryPinoLogger()` before any spec import.
- `[ ]` None of the three e2e bootstrap calls in `test/system-api.e2e-spec.ts` passes `logger: false`.
- `[ ]` `tests/lint/architecture-lint.spec.ts` is unchanged (out of scope, but verify it remains green via `yarn test:unit`).
- `[ ]` `migrations/**` is unchanged.

## On Failure
If any step fails irrecoverably within this phase's scope, stop, leave the repository in a clean state (revert partial diffs if needed), record the failure under "Open / deferred" in the carryover document with enough detail for a human to triage (which file, which test failed, the skill's last-attempted intent), and exit without marking the phase completed. Because this is the final phase, a failure here is the natural hand-off to a human reviewer.
