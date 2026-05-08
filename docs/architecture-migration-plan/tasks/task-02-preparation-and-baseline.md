# task-02 — Preparation and baseline (Phase 0)

## Context

- Migration plan: `docs/architecture-migration-plan/parts/recommendation.md`
- Conventions preamble: `docs/architecture-migration-plan/tasks/task-01-review-project-and-update-plan.md`
- Previous carryover: `docs/architecture-migration-plan/tasks/_carryover-01.md`
- Project conventions: `CLAUDE.md`
- Where we are in the migration: task-01 reconciled the plan with the
  live tree on `RIS-25-Architecture-migration` and locked in five
  conventions (`-microservice` suffix, `@retail-inventory-system/<name>`
  alias prefix, 3-digit ADRs, `libs/auth` deferred to task-06, no
  `docs/architecture/` folder). The repo is on the migration branch.
  No code has moved. This task captures the **baseline** so later
  tasks can diff against it and so test-coverage regressions are caught.

## Prerequisites

- [ ] `_carryover-01.md` exists and was read first.
- [ ] Build is green on entry
  (`yarn install && yarn build && yarn lint && yarn test:unit`).
- [ ] No `-DRAFT.md` task files remain (task-01 finished cleanly).

## Goal

Capture an immutable baseline of the pre-migration repository (config
files, coverage report, workspace graph), install but **do not enable**
`eslint-plugin-boundaries` so task-12 can switch it on later, and add a
Phase-0 ADR recording the migration as an architectural commitment.
No code moves in this task.

## Steps

1. **Create `docs/baseline/`** and copy verbatim (no `tsconfig.build.json`
   — it does not exist in this repo):
   - `nest-cli.json`
   - `tsconfig.json`
   - `package.json` (dependency block + scripts; do not duplicate the
     lockfile)
   - `docker-compose.yml`
   - `eslint.config.mjs`
   - `jest.unit.config.js`, `jest.e2e.config.js`
   - `webpack.config.js`
   - `.github/workflows/ci-cd.yml`
   - `migrations/config/data-source.ts`
   Each copy carries a header comment with the capture date and the
   commit SHA. The originals are untouched.

2. **Capture the test coverage baseline.** Run
   `yarn test:unit --coverage --coverageReporters=text-summary` and
   save stdout to `docs/baseline/coverage.txt`. Do **not** commit any
   Jest config edit just to produce coverage — pass the flag at the CLI.

3. **Capture the workspace snapshot.**
   `yarn workspaces list --json > docs/baseline/workspaces.json` (Yarn 4
   syntax) so later phases can reason about the workspace shape that
   was in place at the start.

4. **Install `eslint-plugin-boundaries`** as a dev dependency:
   `yarn add -D eslint-plugin-boundaries`. Do **not** add it to
   `eslint.config.mjs` `plugins` yet, do **not** add rules. Just record
   the dep in `package.json` and `yarn.lock`. The choice over
   `eslint-plugin-import`'s `no-restricted-paths` is intentional:
   `boundaries` lets us declare element types and edges directly,
   matching Section 3 of the recommendation. The existing config does
   use `import` (via `eslint-import-resolver-typescript`) but only for
   resolution, not for path restrictions.

5. **Add an ADR "Adopt hexagonal architecture per service"** at the
   next free 3-digit slot in `docs/adr/` (003 is taken by the
   record-architecture-decisions ADR added in task-01; this ADR is
   most likely **004**). Body: cite `parts/recommendation.md` as the
   target spec; list the bounded contexts
   (retail, inventory, notification, gateway); state the per-module
   `domain/application/infrastructure/presentation` layout. Status:
   Accepted; date: today.

6. **Architecture-lint workflow placeholder.** The existing
   `.github/workflows/ci-cd.yml` already runs `yarn lint` in a
   dedicated `lint` job that gates `build` / `unit` / `e2e`. Adding a
   second workflow file that runs the same `yarn lint` would
   duplicate work. Instead, add a comment block at the top of
   `ci-cd.yml`'s `lint` step noting that task-12 will extend it with
   `yarn lint:architecture` once `eslint-plugin-boundaries` rules are
   on. No new workflow file is created in this task.

## Documentation updates required

- [ ] `README.md`: add a "Migration baseline" sub-section under the
  "Architecture migration in progress" header (added in task-01)
  pointing to `docs/baseline/` and stating "this folder is read-only
  — captured as the pre-migration snapshot."
- [ ] `CLAUDE.md`: add a one-line note that `docs/baseline/` is a
  frozen pre-migration snapshot and must not be edited.
- [ ] `docs/adr/004-adopt-hexagonal-architecture-per-service.md`:
  new ADR (number = next free at task time; recorded in
  `_carryover-02.md`).

## Verification

- [ ] `yarn install` succeeds.
- [ ] `yarn build` succeeds for all four apps.
- [ ] `yarn lint` succeeds.
- [ ] `yarn test:unit` succeeds.
- [ ] `docs/baseline/` exists with every file listed in step 1, plus
  `coverage.txt` and `workspaces.json`.
- [ ] `eslint-plugin-boundaries` appears in `package.json`
  `devDependencies` and in `yarn.lock`, but is **not** referenced in
  `eslint.config.mjs`.
- [ ] The new ADR exists with a 3-digit number and Status: Accepted.

## Carryover

Write `_carryover-02.md` with:
- Files created (paths + one-line summaries).
- Coverage baseline numbers (overall % statements / branches / functions
  / lines, plus per-app where the reporter exposes it).
- The `eslint-plugin-boundaries` install confirmation
  (version, lockfile hash diff lines).
- The exact ADR number assigned (since task-01 created 003, this task
  expects 004).
- Verification results (raw command output).
- Suggested adjustments to task-12 (which will enable the
  `boundaries` rules) — e.g., element-type globs informed by the
  inventory captured in `_carryover-01.md`.
