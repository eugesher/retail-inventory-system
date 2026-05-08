# task-01 — Review project and update migration plan

This task grounds the architecture migration plan in the **actual** repository
state. The plan in `docs/architecture-migration-plan/parts/` was reconstructed
from a written brief without the repository in hand; many claims are tagged
`(assumed)`. Before any code change happens, this task verifies each claim
against the live tree, edits the plan files in place where they diverge from
reality, and finalizes the downstream task drafts (`task-02-…-DRAFT.md` …
`task-14-…-DRAFT.md`) by either confirming, editing, splitting, merging, or
deleting them and renaming `…-DRAFT.md` → `…md`.

---

## Conventions for every task in this folder (preamble — referenced by all later tasks)

These rules apply to **every** `task-NN-….md` in this directory. Later tasks
will link back here rather than restate them.

1. **Self-containment.** Each task runs in a cleared Claude Code context. The
   task file must be sufficient on its own. Every task's "Context" section
   points at the migration plan, the previous task's carryover, `CLAUDE.md`,
   and one paragraph naming where in the migration the project currently is.
2. **No Git operations.** Tasks run in a pre-configured branch
   (`RIS-25-Architecture-migration` at the time of writing). Do **not** run
   `git add`, `git commit`, `git push`, `git branch`, `git checkout`,
   `git tag`, `git merge`, or `git stash`. Do not modify `.git/`. Do not
   write hooks. `.gitignore` may be edited only when the task creates new
   classes of file that should not be tracked (`coverage/`, `dist/`,
   `.tsbuildinfo`, etc.) — and the addition must be explicitly noted in the
   task body.
3. **Documentation discipline.** The folder
   `docs/architecture-migration-plan/tasks/` (this folder) and every
   `_carryover-NN.md` will be **deleted before this branch is merged into
   `main`**. Anything that must survive merge has to land in:
   - `README.md` (top-level overview, how to run, structure, dev workflow)
   - `CLAUDE.md` (instructions for future AI sessions: layout, conventions,
     rules, gotchas)
   - `docs/adr/NNN-*.md` (one ADR per architectural decision actually
     applied; sequential numbering — see ADR numbering rule below)

   Every task that mutates the codebase MUST update at least one of those
   three. The "Documentation updates required" section spells out exactly
   which files and what to add — concretely, not "update the README".
4. **Carryover files.** After completing task-NN, the executing session
   writes
   `docs/architecture-migration-plan/tasks/_carryover-NN.md`
   containing: **Completed**, **Deferred**, **Unexpected findings**,
   **Verification results** (raw command output), **Suggested adjustments**.
   The first action of every task after task-01 is `Read _carryover-(NN-1).md`.
   If it is missing, the task fails fast.
5. **Verification gate.** Every task ends with a verification block. Mandatory
   checks: `yarn install`, `yarn build` (must build all four apps via
   `nest build --all`), `yarn lint`, `yarn test:unit`. Optional checks
   (when the task touches covered paths): `yarn test:e2e`. If any mandatory
   check fails and cannot be fixed within the task scope, the task marks
   itself **BLOCKED** in the carryover and stops — it does **not** paper
   over the failure with skipped tests, `--no-verify`, or commented-out code.
6. **Granularity.** A task is the right size when it can be completed in one
   Claude Code session, reviewed as a single PR / squashed commit, and left
   in a buildable + lint-clean + test-green state. Phases that don't fit
   that envelope are split (Phase 1 of the checklist is already split into
   task-03 and task-04 for that reason).
7. **Package manager.** This repo uses **Yarn 4 (Berry)** with
   `packageManager: yarn@4.12.0` in `package.json` and a `yarn.lock` at the
   root. All commands in every task use `yarn`, not `pnpm` or `npm`.
8. **App naming.** The four apps are
   `api-gateway`, `inventory-microservice`, `retail-microservice`,
   `notification-microservice` — note the `-microservice` suffix on the
   three domain services. The plan files in `parts/` shorten these to
   `retail`, `inventory`, `notification`; task-01 will decide whether to
   rename the folders or update the plan to match the existing names. Until
   that decision is recorded in `_carryover-01.md`, every later task uses
   the **actual** folder names.
9. **TS path aliases.** Existing aliases use the
   `@retail-inventory-system/<name>` prefix (see `tsconfig.json`), not
   `@app/<name>` as the recommendation document assumes. Task-01 reconciles
   this; later tasks defer to whichever convention `_carryover-01.md` blesses.
10. **ADR numbering.** Existing ADRs use **3-digit** padding
    (`docs/adr/001-…`, `docs/adr/002-…`). The recommendation document uses
    4-digit padding (`0001-…`, `0002-…`). Task-01 picks one convention and
    records it. Until then, later tasks write `NNN-` (3-digit) to match
    what's on disk and flag it for task-01.
11. **Honesty about uncertainty.** Drafts may contain
    `(verify in task-01: <thing>)` annotations. Task-01 either resolves them
    in place or leaves the annotation as a TODO for the executing session of
    that task.

---

## Context

- Migration plan overview: `docs/architecture-migration-plan/architecture-migration-plan.md`
- Project audit (RECONSTRUCTED FROM BRIEF, items tagged `(assumed)`):
  `docs/architecture-migration-plan/parts/project-audit.md`
- Boilerplate comparison: `docs/architecture-migration-plan/parts/boilerplate-comparison.md`
- Final recommendation (target architecture, naming, module rules):
  `docs/architecture-migration-plan/parts/recommendation.md`
- Migration checklist (Phase 0…7):
  `docs/architecture-migration-plan/parts/migration-checklist.md`
- Source URLs consulted: `docs/architecture-migration-plan/parts/sources.md`
- Project conventions today: `CLAUDE.md`
- Task drafts awaiting confirmation: every
  `docs/architecture-migration-plan/tasks/task-NN-…-DRAFT.md` in this folder.

The audit was reconstructed without access to the repository; the orchestrator
session that produced these task files **did** spot-check the live tree and
recorded several known divergences in the drafts (see point 7–10 of the
preamble above). This task formally reconciles every divergence.

## Prerequisites

- [ ] All five plan files under
  `docs/architecture-migration-plan/parts/` exist and are readable.
- [ ] All `task-NN-…-DRAFT.md` files (task-02 through task-14) exist in
  `docs/architecture-migration-plan/tasks/`.
- [ ] **Build is green on entry.** Run `yarn install && yarn build && yarn lint && yarn test:unit` before doing anything else. If any of these fails, mark the task **BLOCKED** in `_carryover-01.md`, record the failure verbatim, and stop. Task-01 is otherwise expected to keep the build green throughout.
- [ ] The current branch is `RIS-25-Architecture-migration` (or the migration
  branch named in the orchestrator's most recent message — verify before
  starting).

## Goal

Replace every `(assumed)` claim in the plan with verified fact, rewrite the
plan paragraphs that turn out to be wrong, and produce a coherent, finalized
sequence of executable tasks (`task-01.md` … `task-NN.md`) that future
cleared-context sessions can run end-to-end. The output of this task is
**documentation only** — no code is moved or rewritten in task-01.

## Steps

1. **Inventory the actual repository.** Capture, in this order:
   - `tree -L 4 apps libs docs` (fall back to
     `find apps libs docs -maxdepth 4 -type f \( -name '*.ts' -o -name '*.json' -o -name '*.md' \) | sort` if `tree` is absent).
   - The contents of `nest-cli.json`, `package.json`, `tsconfig.json`,
     `tsconfig.build.json`, `docker-compose.yml`, `eslint.config.mjs`,
     `jest.unit.config.js`, `jest.e2e.config.js`, `webpack.config.js`,
     `migrations/config/data-source.ts`.
   - For each app under `apps/`: enumerate every `*.module.ts`,
     `*.controller.ts`, `*.service.ts`, `*.entity.ts`, every DTO file,
     every `@MessagePattern` / `@EventPattern` decorator usage, every
     RabbitMQ `client.send` / `client.emit` call, every Redis usage, every
     JWT/passport/guard reference, every Pino reference, every test file,
     and any cross-app imports (an `apps/X` file importing from `apps/Y`).
   - For each lib under `libs/`: enumerate all exported symbols and which
     apps consume them.
   - The current ADR set under `docs/adr/` (filenames + titles).
   Save this raw inventory verbatim into `_carryover-01.md` under a
   `## Repository inventory` heading — later tasks will reference it.

2. **Diff the audit against reality.** For each `(assumed)` claim in
   `parts/project-audit.md` (Sections 1, 2, 3, 4, 5, 6), classify it as
   **CONFIRMED**, **REFUTED**, or **AMENDED** in a markdown table. Known
   open questions the orchestrator already flagged that you must resolve:

   | Claim from audit / recommendation                           | Reality (orchestrator spot-check)                                                | Resolution needed |
   |-------------------------------------------------------------|----------------------------------------------------------------------------------|-------------------|
   | Apps are `api-gateway, retail, inventory, notification`     | Folders are `api-gateway, retail-microservice, inventory-microservice, notification-microservice` | Decide: rename or accept the suffix and update plan/recommendation |
   | `libs/common` is the only shared lib                        | Four libs already exist: `common`, `config`, `inventory`, `retail`               | Re-map the Phase 1 split onto the existing libs |
   | JWT + RBAC at the gateway                                   | No `@nestjs/jwt`/`passport` in deps, no `auth/` folder under `api-gateway/src/`  | Strike auth claims from audit; either drop `libs/auth` from the recommendation or scope it as new work |
   | Service classes are fat (TypeORM + RabbitMQ + Redis in one) | Service layout is `app/api/<feature>/providers/*-<action>.service.ts` (one service per action) | Re-evaluate "fat services" critique; the per-action split is partial progress toward use cases |
   | Redis is provisioned but unused                             | `libs/common/cache` exists; ADR-002 documents Redis cache-aside applied to product stock | Update audit Sections 4.8 and 6.2; re-scope task-11 |
   | Path aliases are `@app/<name>`                              | Aliases are `@retail-inventory-system/<name>`                                    | Pick a convention and update either `tsconfig.json` or every `@app/…` reference in the recommendation |
   | ADRs use 4-digit numbering (`0001-…`)                       | Existing ADRs use 3-digit (`001-…, 002-…`)                                       | Pick one and apply consistently. Next free number is 003 (3-digit) or 0003 (4-digit) |
   | `docs/architecture/` exists for diagrams                    | (verify) — not present in orchestrator's spot-check                              | Decide whether to create it (Phase 6) or drop it from the recommendation |

   Add any further divergences you discover in step 1 to that table.

3. **Edit the plan files in place.** Apply the resolutions from step 2 to:
   - `docs/architecture-migration-plan/parts/project-audit.md` — rewrite the
     reconstructed tree (Section 2) to match reality, update the stack
     snapshot (Section 1), the "what feels ad-hoc" list (Section 4), and
     "planned-but-not-yet-implemented" (Section 6). Replace `(assumed)`
     tags with `(verified 2026-MM-DD)` where confirmed; remove them where
     the claim was wrong.
   - `docs/architecture-migration-plan/parts/recommendation.md` — adjust
     the target directory tree (Section 2) for the actual app names; fix
     the path-alias prefix throughout; if `libs/auth` is dropped, remove
     it from Sections 2, 3, and 6 in one consistent pass.
   - `docs/architecture-migration-plan/parts/migration-checklist.md` —
     re-scope each phase to the actual starting state; remove items that
     have already been done (e.g., Redis cache-aside on product-stock per
     ADR-002); add items the orchestrator missed.

   Do **not** delete material wholesale — when something turns out to be
   wrong, rewrite the affected paragraphs and ensure no contradictions
   remain between sections.

4. **Append a "Plan Revisions" changelog** to the bottom of
   `docs/architecture-migration-plan/architecture-migration-plan.md` with
   one bullet per file changed in step 3, format
   `- <path> — <one-line rationale>` and dated today.

5. **Review every `task-NN-…-DRAFT.md` file.** For each draft, in numeric
   order:
   - Read it end-to-end.
   - Compare its Steps and Prerequisites against the now-corrected plan
     and the actual repository.
   - Decide: **keep-as-is**, **edit**, **split** (becomes two tasks),
     **merge** (folded into a neighbour), or **delete**.
   - If kept or edited: rename the file from
     `task-NN-<slug>-DRAFT.md` → `task-NN-<slug>.md`.
   - If split: create the new file, name it `task-NN-<slug>.md` (or insert
     at the next contiguous number — see step 6), and write its full body
     using the template in section "Task file template" below.
   - If deleted: remove the file and record the rationale in the carryover.

6. **Renumber for contiguity.** If splits/merges/deletes change the count,
   renumber every later task so the sequence is contiguous (`task-01` …
   `task-NN`) with two-digit padding. Update every cross-reference between
   tasks (e.g., a Prerequisite that says "after task-07 …" must reflect the
   new number). Record the rename map in `_carryover-01.md`.

7. **Documentation updates.** See "Documentation updates required" below.

8. **Carryover.** Write `_carryover-01.md` per the structure in "Carryover"
   below.

## Documentation updates required

- [ ] **`README.md`** — add or refresh a top-level section
  "Architecture migration in progress" pointing readers at
  `docs/architecture-migration-plan/`. Explicitly state that the
  `tasks/` folder is **scratch** for the migration and will be deleted
  before this branch merges into `main`. State that the durable
  architectural artefacts are this README, `CLAUDE.md`, and
  `docs/adr/`.
- [ ] **`CLAUDE.md`** — add three sub-sections (create the file if it is
  missing — but the orchestrator confirmed it exists):
  1. **Architecture rules location.** "Architectural rules and target
     state are defined in `docs/architecture-migration-plan/parts/recommendation.md`
     and recorded as ADRs under `docs/adr/`. The migration plan
     (`docs/architecture-migration-plan/`) is the *transition* artefact;
     ADRs are the durable record."
  2. **No-Git-ops rule for migration tasks.** "Sessions executing a
     `task-NN.md` file from `docs/architecture-migration-plan/tasks/`
     do **not** run `git add`, `git commit`, `git push`, or any other
     branch-modifying command. Commits and PRs are the human's job."
  3. **Carryover-file pattern.** "Each migration task produces a
     `_carryover-NN.md` next to it; the next task reads it as its first
     action. Carryovers are deleted with the rest of `tasks/` before
     merge — anything durable goes in this file, the README, or an ADR."

  Also: refresh the Known Issues block — Redis is no longer unused (per
  ADR-002).
- [ ] **`docs/adr/NNN-record-architecture-decisions.md`** — create using
  the **MADR** template (the existing 001/002 use a hybrid Nygard/MADR
  shape; pick whichever convention task-01 records). Number using the
  3-digit padding the directory already uses; the next free number is
  **003**. Title: "Record architecture decisions". Status: Accepted.
  Decision: "We will use ADRs as described by Michael Nygard / MADR to
  record significant architectural decisions in this project."
- [ ] **`docs/architecture-migration-plan/architecture-migration-plan.md`**
  — append the "Plan Revisions" changelog from step 4.
- [ ] **`docs/architecture-migration-plan/parts/project-audit.md`** —
  rewrite per step 3.
- [ ] **`docs/architecture-migration-plan/parts/recommendation.md`** —
  rewrite per step 3.
- [ ] **`docs/architecture-migration-plan/parts/migration-checklist.md`**
  — rewrite per step 3.

## Verification

- [ ] `yarn install` succeeds.
- [ ] `yarn build` succeeds for all four apps (`api-gateway`,
  `inventory-microservice`, `retail-microservice`,
  `notification-microservice`).
- [ ] `yarn lint` succeeds (`--max-warnings 0`).
- [ ] `yarn test:unit` succeeds.
- [ ] Every `task-NN-…-DRAFT.md` has been either renamed (no `-DRAFT`
  suffix) or deleted; **no `-DRAFT.md` files remain** in
  `docs/architecture-migration-plan/tasks/`.
- [ ] `_carryover-01.md` exists and is complete per the section below.
- [ ] All cross-references between task files resolve (no dangling
  "see task-XX" pointing at a non-existent file).

Task-01 is primarily a docs-and-task-files task; if any verification
command is red **on entry** it must be reported in the carryover. Task-01
is not expected to fix a pre-existing red build, but it must not introduce
new failures.

## Carryover

Write `docs/architecture-migration-plan/tasks/_carryover-01.md` with:

1. **Files edited.** A bullet list of every file changed under
   `docs/`, `README.md`, `CLAUDE.md`. One-line rationale per file.
2. **Repository inventory.** The raw output captured in step 1 (tree,
   per-app feature inventory, libs export inventory, ADR list).
3. **Audit reconciliation table.** Every `(assumed)` claim with verdict
   (CONFIRMED / REFUTED / AMENDED) and the resolution applied.
4. **Convention decisions.** What was decided for: app folder names
   (rename or accept suffix), path-alias prefix, ADR padding width,
   `libs/auth` (drop / keep / scope as new), `docs/architecture/`
   (create / drop). One bullet per decision with one-line rationale.
5. **Task draft reconciliation table.** For each draft: kept / edited /
   split / merged / deleted, plus the new filename.
6. **Final task list in execution order**, with new filenames.
7. **Verification results.** Raw output of `yarn install`,
   `yarn build`, `yarn lint`, `yarn test:unit`. If anything was red
   on entry, say so and link the failure to a specific task that should
   address it.
8. **Anything unexpected** — undocumented tooling
   (e.g., `webpack.config.js`, custom `migration-create.ts` script,
   `scripts/bash/start-dev.sh`), monorepo quirks, or dependencies the
   plan didn't anticipate. Flag anything that materially changes the
   shape of an upcoming task.

## Task file template

The skeleton every task in this folder must use (already followed by the
drafts task-02 … task-14):

```markdown
# task-NN — <title>

## Context
- Migration plan: `docs/architecture-migration-plan/parts/recommendation.md`
- Conventions preamble: `docs/architecture-migration-plan/tasks/task-01-review-project-and-update-plan.md`
- Previous carryover: `docs/architecture-migration-plan/tasks/_carryover-(NN-1).md`
- Project conventions: `CLAUDE.md`
- Where we are in the migration: <one paragraph>

## Prerequisites
- [ ] `_carryover-(NN-1).md` exists and was read first
- [ ] Build is green on entry (`yarn install && yarn build && yarn lint && yarn test:unit`)
- [ ] <task-specific prerequisites>

## Goal
<single-paragraph statement>

## Steps
1. <concrete action>
2. <concrete action>
…

## Documentation updates required
- [ ] `README.md`: <specific section / change>
- [ ] `CLAUDE.md`: <specific addition / change>
- [ ] `docs/adr/NNN-<slug>.md`: <new ADR title and decision> (where applicable)

## Verification
- [ ] `yarn install` succeeds
- [ ] `yarn build` succeeds for all four apps
- [ ] `yarn lint` succeeds
- [ ] `yarn test:unit` succeeds
- [ ] <task-specific assertion, e.g. "the products module compiles with the new layout">

## Carryover
Write `docs/architecture-migration-plan/tasks/_carryover-NN.md` with:
- Completed (files + one-line summaries)
- Deferred (with reasons)
- Unexpected findings
- Verification results (raw)
- Suggested adjustments to upcoming tasks
```
