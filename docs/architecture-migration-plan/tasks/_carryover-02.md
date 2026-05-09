# _carryover-02.md — Preparation and baseline (Phase 0)

> Generated 2026-05-09 by the task-02 session on branch
> `RIS-26-Architecture-migration-Phase-2-Preparation-and-baseline`.
> Entry-gate commit: `04713bb` (the merge of task-01 into `main` /
> the head of the migration line at task-02 start). The next task
> (`task-03-extract-shared-libs-foundation.md`) reads this file as
> its first action and fails fast if it is missing.

## 1. Files created

### Baseline snapshot (frozen, read-only)

| Path | One-line summary |
|------|------------------|
| `docs/baseline/nest-cli.json` | Verbatim copy of root `nest-cli.json`; first key is a `"//"` comment carrying capture date + commit SHA. |
| `docs/baseline/tsconfig.snapshot.json` | Verbatim copy of root `tsconfig.json` with the same `"//"` header. **Renamed** from `tsconfig.json` — see "Filename renames" note below. |
| `docs/baseline/package.snapshot.json` | Reproduces only the `name`, `private`, `packageManager`, `workspaces`, `scripts`, `dependencies`, `devDependencies` blocks; the lockfile is **not** duplicated, per task-02 step 1. **Renamed** from `package.json`. |
| `docs/baseline/docker-compose.yml` | Verbatim copy with a leading `#` header comment. |
| `docs/baseline/eslint.config.snapshot.mjs` | Verbatim copy with a leading `//` header. Captured **before** `docs/baseline/**` was added to the live `eslint.config.mjs` ignores list, so the snapshot reflects the genuine pre-task-02 state. **Renamed** from `eslint.config.mjs`. |
| `docs/baseline/jest.unit.config.js` | Verbatim copy with a leading `//` header. Captured **before** the `modulePathIgnorePatterns` line was added to the live `jest.unit.config.js`. |
| `docs/baseline/jest.e2e.config.js` | Same as above for the e2e Jest config. |
| `docs/baseline/webpack.config.js` | Verbatim copy with a leading `//` header. |
| `docs/baseline/ci-cd.yml` | Source path `.github/workflows/ci-cd.yml`. Captured **before** the task-12 follow-up comment block was added. |
| `docs/baseline/data-source.ts` | Source path `migrations/config/data-source.ts`. Verbatim copy with a leading `//` header. |
| `docs/baseline/coverage.txt` | `yarn test:unit --coverage --coverageReporters=text-summary` output. |
| `docs/baseline/workspaces.json` | `yarn workspaces list --json` output (5 lines: root + 4 apps). |

**Filename renames (`tsconfig.snapshot.json`, `package.snapshot.json`,
`eslint.config.snapshot.mjs`).** Three of the snapshot files were
renamed from their original tooling-discovery names. The trigger was
the husky pre-commit hook running `lint-staged → yarn lint:fix`,
which invokes `eslint` with absolute file paths. Under that
invocation tseslint's `projectService: true` walks the entire repo
to discover candidate "TSConfigRootDirs" and treats any directory
that holds a `tsconfig.json`, `package.json`, or `eslint.config.mjs`
as a separate project root. With those filenames present in
`docs/baseline/`, lint-staged failed on every staged TS file with:

> Parsing error: No tsconfigRootDir was set, and multiple candidate
> TSConfigRootDirs are present: `/.../docs/baseline`, `/.../`

Adding `docs/baseline/**` to the eslint `ignores` list does **not**
help — eslint's ignores affect which files get linted, not which
projects tseslint's project-service discovers. Setting
`parserOptions.tsconfigRootDir = import.meta.dirname` and adding
`exclude: ['docs/baseline/**']` to the root `tsconfig.json` were
both tried and neither suppressed the warning. The empirical fix is
to keep the snapshot files but give them filenames that auto-discovery
ignores; `*.snapshot.{json,mjs}` is the chosen pattern. The contents
are untouched, so a reader can still diff each baseline file against
its live counterpart by stripping the `.snapshot` infix.

The Jest haste-collision warning (which targets `package.json` for a
different reason — the `"name"` field collision) was already silenced
in this task via `modulePathIgnorePatterns` and is independent of the
above. Both fixes are needed: `modulePathIgnorePatterns` for jest,
the `*.snapshot.*` rename for tseslint.

### Architecture record

| Path | One-line summary |
|------|------------------|
| `docs/adr/004-adopt-hexagonal-architecture-per-service.md` | Status: Accepted (2026-05-09). Bounded contexts: retail / inventory / notification / gateway. Per-module layout: `domain | application | infrastructure | presentation`. Cites `recommendation.md` Sections 1–4 for the operative details and lists three rejected alternatives (Awesome Nest Boilerplate, Domain-Driven Hexagon, "lint without restructure"). |

### Documentation updates

| Path | Edit |
|------|------|
| `README.md` | Added a new sub-section **"Migration baseline"** under the existing "Architecture migration in progress" section, pointing at `docs/baseline/` and stating the folder is read-only. |
| `CLAUDE.md` | Added a new sub-section **"Baseline snapshot"** under "Architecture migration"; corrected the stale "next free [ADR] number is 003" line to read `004` already taken, next free `005`. **Tracking note:** `CLAUDE.md` was previously listed in this clone's `.git/info/exclude` (line 8), so task-01's edits never reached git history. The user removed that entry mid-session; `CLAUDE.md` now shows as untracked in `git status`. The user is expected to `git add CLAUDE.md` as part of the task-02 commit so the migration record (this carryover and ADR-004) is consistent with the file's claimed durable status. |

### Live configuration changes (small, justified)

These are not part of the baseline, but are needed to keep the
build/lint/test pipeline green now that the baseline folder exists:

| Path | Edit | Rationale |
|------|------|-----------|
| `eslint.config.mjs` | Added `'docs/baseline/**'` to the `ignores` list. | Without it, tseslint discovers two candidate `tsconfig.json` files (root + baseline) and aborts parsing every `test/**/*.ts` file with `No tsconfigRootDir was set`. Adding the ignore is a defensive infra tweak, not a `boundaries`-related change — the baseline snapshot of `eslint.config.mjs` was taken **before** this edit, so the snapshot still reflects the pre-task-02 state. |
| `jest.unit.config.js` | Added `modulePathIgnorePatterns: ['<rootDir>/docs/baseline/']`. | Without it, jest emits `jest-haste-map: Haste module naming collision: retail-inventory-system` because the baseline `package.json` shares the name with the root one. Same justification: the snapshot was captured before the edit. |
| `jest.e2e.config.js` | Same as above. | Same as above. |
| `.github/workflows/ci-cd.yml` | Added a 6-line `#` comment block at the top of the `lint` job describing the task-12 follow-up (`yarn lint:architecture` + `eslint-plugin-boundaries` rules). No new workflow file was created. | Per task-02 step 6. |

## 2. Coverage baseline

Captured by `yarn test:unit --coverage --coverageReporters=text-summary`
on commit `04713bb` after the live `eslint.config.mjs` /
`jest.*.config.js` infra tweaks above (a re-run was needed once the
haste-collision warning was silenced; the numbers themselves do not
move because no source under `apps/` or `libs/` was touched).

| Metric | Coverage | Raw |
|--------|----------|-----|
| Statements | **97.96%** | 434 / 443 |
| Branches | **96.72%** | 59 / 61 |
| Functions | **83.01%** | 44 / 53 |
| Lines | **98.03%** | 400 / 408 |

Per-app numbers are not separable from `text-summary` (the reporter
emits a single project-wide rollup). The tested surface today is
**inventory-microservice product-stock services + retail-microservice
order-confirm domain** (7 spec files, 59 specs). The api-gateway and
notification-microservice carry no spec files at this baseline; this
is expected and matches the inventory documented in `_carryover-01.md`.

The 17.0-pp gap between `Functions` (83.01%) and `Statements` (97.96%)
is mostly per-action services that are wired but lack their own spec
(`product-stock-add` and `product-stock-cache` are tested through the
façade rather than directly). Task-08 (inventory-align) is expected to
close some of that as it preserves and renames the existing specs
alongside the relocated services.

## 3. `eslint-plugin-boundaries` install confirmation

Installed via `yarn add -D eslint-plugin-boundaries`; the plugin is
**not** yet referenced in `eslint.config.mjs` (verified by `grep -c
boundaries eslint.config.mjs` returning 0).

| Field | Value |
|-------|-------|
| Resolved version | **6.0.2** |
| `package.json` entry | `"eslint-plugin-boundaries": "^6.0.2"` (devDependencies) |
| `package.json` numstat | +1 / -0 lines |
| `yarn.lock` numstat | +129 / -3 lines |
| Lockfile resolution line | `"eslint-plugin-boundaries@npm:^6.0.2": resolution: "eslint-plugin-boundaries@npm:6.0.2"` |
| New transitive dependencies | 7 packages added (~5.58 MiB): `@boundaries/elements@2.0.1`, `debug@3.2.7`, `eslint-import-resolver-node@0.3.9`, plus 4 sub-deps. |

## 4. ADR number assigned

**ADR-004** as expected — the slot the task description anticipated
(003 was allocated by task-01 to `record-architecture-decisions`). The
new ADR's slug is `adopt-hexagonal-architecture-per-service`.

The CLAUDE.md `next free number is 003` claim from task-01 was stale
even after task-01 finished (it should have read `004`). Task-02
corrected it to `005`. Future tasks should expect to bump this number
each time an ADR is added.

## 5. Verification — raw command output

### Entry gate (commit `04713bb`)

```
$ yarn install
➤ YN0000: · Yarn 4.12.0
➤ YN0000: ┌ Resolution step
➤ YN0000: └ Completed in 0s 396ms
➤ YN0000: ┌ Fetch step
➤ YN0000: └ Completed in 1s 140ms
➤ YN0000: ┌ Link step
➤ YN0000: └ Completed in 0s 483ms
➤ YN0000: · Done in 2s 118ms

$ yarn build
webpack 5.106.0 compiled successfully in 7596 ms
webpack 5.106.0 compiled successfully in 8502 ms
webpack 5.106.0 compiled successfully in 8323 ms
webpack 5.106.0 compiled successfully in 8078 ms

$ yarn lint
# (no output; --max-warnings 0 succeeds clean)
# exit 0

$ yarn test:unit
PASS apps/retail-microservice/src/app/api/order/domain/spec/order-confirm.domain.spec.ts (9.963 s)
PASS apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/spec/product-stock-common-add.service.spec.ts (9.751 s)
PASS apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/spec/product-stock-common-get.service.spec.ts (9.727 s)
PASS apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/spec/product-stock-common-cache.service.spec.ts (9.989 s)
PASS apps/inventory-microservice/src/app/common/modules/product-stock-common/spec/product-stock-common.service.spec.ts (9.982 s)
PASS apps/inventory-microservice/src/app/api/product-stock/providers/spec/product-stock-get.service.spec.ts (10.303 s)
PASS apps/inventory-microservice/src/app/api/product-stock/providers/spec/product-stock-order-confirm.service.spec.ts (10.656 s)

Test Suites: 7 passed, 7 total
Tests:       59 passed, 59 total
Snapshots:   0 total
Time:        12.298 s
Ran all test suites.
```

### Exit gate (post-task-02)

```
$ yarn install
➤ YN0000: · Yarn 4.12.0
➤ YN0000: ┌ Resolution step
➤ YN0000: └ Completed in 0s 364ms
➤ YN0000: ┌ Fetch step
➤ YN0000: └ Completed in 1s 51ms
➤ YN0000: ┌ Link step
➤ YN0000: └ Completed in 0s 493ms
➤ YN0000: · Done in 2s 157ms

$ yarn build
webpack 5.106.0 compiled successfully in 8295 ms
webpack 5.106.0 compiled successfully in 8291 ms
webpack 5.106.0 compiled successfully in 8921 ms
webpack 5.106.0 compiled successfully in 8466 ms

$ yarn lint
# (no output; exit 0)

$ yarn test:unit
PASS apps/inventory-microservice/src/app/api/product-stock/providers/spec/product-stock-order-confirm.service.spec.ts (11.383 s)
PASS apps/inventory-microservice/src/app/api/product-stock/providers/spec/product-stock-get.service.spec.ts (11.492 s)
…
Test Suites: 7 passed, 7 total
Tests:       59 passed, 59 total
Snapshots:   0 total
Time:        13.203 s, estimated 18 s
Ran all test suites.
```

All four exit gates pass. Coverage numbers are identical pre/post,
as expected (no source under `apps/` or `libs/` was modified).

### Final working-tree state

```
$ git status -s
 M .github/workflows/ci-cd.yml
 M README.md
 M eslint.config.mjs
 M jest.e2e.config.js
 M jest.unit.config.js
 M package.json
 M yarn.lock
?? docs/adr/004-adopt-hexagonal-architecture-per-service.md
?? docs/baseline/

$ git diff --stat HEAD
 .github/workflows/ci-cd.yml |   6 ++
 README.md                   |   4 ++
 eslint.config.mjs           |   1 +
 jest.e2e.config.js          |   1 +
 jest.unit.config.js         |   1 +
 package.json                |   1 +
 yarn.lock                   | 132 +++++++++++++++++++++++++++++++++++++++++++-
 7 files changed, 143 insertions(+), 3 deletions(-)
```

(`CLAUDE.md` did not appear in the `git status -s` capture above
because it was still in `.git/info/exclude` at that moment. The
exclude entry was removed mid-session; `CLAUDE.md` is now untracked
and will appear in subsequent `git status` runs. See §1.)

## 6. Suggested adjustments to task-12 (architecture-lint enable)

Element-type globs informed by the inventory captured in
`_carryover-01.md` plus `workspaces.json`:

```yaml
elements:
  - type: app                  # apps/*/src
    pattern: 'apps/*/src/**'
    capture: ['app']
  - type: module-domain
    pattern: 'apps/*/src/{app/api,modules}/*/domain/**'
    capture: ['app', 'module']
  - type: module-application
    pattern: 'apps/*/src/{app/api,modules}/*/application/**'
    capture: ['app', 'module']
  - type: module-infrastructure
    pattern: 'apps/*/src/{app/api,modules}/*/infrastructure/**'
    capture: ['app', 'module']
  - type: module-presentation
    pattern: 'apps/*/src/{app/api,modules}/*/presentation/**'
    capture: ['app', 'module']
  - type: lib-common
    pattern: 'libs/common/**'
  - type: lib-config
    pattern: 'libs/config/**'
  - type: lib-contracts        # libs/inventory, libs/retail
    pattern: 'libs/{inventory,retail}/**'
  # libs/auth element type to be added by task-06.
```

Specific recommendations for task-12:

1. **Use `apps/*` not `apps/*/src`-from-root** for the top-level
   `app` element; the existing eslint `no-restricted-imports` rule
   already references `apps/*` as the unit of analysis, so reusing
   the granularity keeps the two configs aligned.
2. **Recognize both `app/api/<feature>/` and `modules/<module>/`**
   structures for `module-*` elements during the migration window
   (tasks 03–09). Some services will reach the target shape before
   others; allowing both prevents the `boundaries` rules from
   blocking PRs that move only one service.
3. **`libs/*` element types must match by directory pattern**, not by
   `yarn workspaces list` output. As of 2026-05-09 the four `libs/*`
   directories have **no** `package.json` — they are TypeScript-path
   aliases only. `yarn workspaces list --json` returns the root + 4
   apps, nothing else. (Captured in `docs/baseline/workspaces.json`.)
4. **Relax the `class-validator` allow-list for `lib-contracts`.**
   `libs/retail` ships `OrderCreateDto` and others with
   `class-validator` decorators; if the rule says "domain layer must
   not import `class-validator`", scope it to `module-domain`, not
   `lib-contracts`.
5. **Postpone naming-convention extension.** The two existing
   `@typescript-eslint/naming-convention` rules (interface → `I*`,
   enum → `*Enum`) already enforce conventions that recommendation
   Section 4 builds on; task-12 should not add overlapping rules.

## 7. Anything unexpected

- **`tsconfig.json` discovery — partial fix at write time, full fix
  triggered by the pre-commit hook.** Putting `tsconfig.json` /
  `package.json` / `eslint.config.mjs` under `docs/baseline/` caused
  tseslint to abort with "multiple candidate TSConfigRootDirs are
  present". Adding `docs/baseline/**` to the eslint `ignores` was
  enough to make `yarn lint` pass at the project level (because
  `eslint .` skips the ignored files entirely), but **lint-staged**
  invokes `eslint` with absolute file paths to TS files OUTSIDE the
  baseline, and the project-service still discovers the baseline as
  a candidate root regardless of ignores. The full fix renames the
  three trigger files in `docs/baseline/` to `*.snapshot.{json,mjs}`
  — see §1 "Filename renames". Both fixes are kept (the ignore is
  defence-in-depth; the rename is the load-bearing one).
- **Jest haste collision.** Same root cause: the baseline `package.json`
  shares a name with the root `package.json`. Fixed by adding
  `modulePathIgnorePatterns: ['<rootDir>/docs/baseline/']` to both
  jest configs. Without the fix the test run succeeds, but emits a
  noisy "Haste module naming collision" warning on every invocation.
- **CLAUDE.md was locally excluded — and is no longer.** Discovered
  in `.git/info/exclude` (line 8); the user removed that entry
  mid-session. `CLAUDE.md` is now untracked and ready to be added
  to the commit. See §1.
- **`yarn workspaces list` returns only `apps/*`.** The `libs/*`
  glob in the root `package.json` `workspaces` array maps to nothing
  because no `libs/<name>/package.json` exists. This is recorded in
  the baseline snapshot and called out in §6 for task-12. If task-04
  decides to promote each lib to a real workspace (by giving it a
  `package.json`), the baseline snapshot will start to look outdated
  in that one specific way — that is expected.
- **Worker-process force-exit warning during `yarn test:unit
  --coverage`.** `A worker process has failed to exit gracefully and
  has been force exited.` This is pre-existing (likely a Pino
  transport, TypeORM pool, or ClientProxy that does not `.unref()`)
  and not introduced by task-02. The suite still passes; the warning
  is noise. Track for task-08 (inventory-align) and/or the
  TEST-002 audit item ("Pino disabled in E2E").
- **eslint-plugin-boundaries 6.0.2 transitively installs
  `@boundaries/elements@2.0.1` and `debug@3.2.7`.** Both are
  established packages, no audit flags. Listed here so task-12 can
  reference them when explaining the dep chain.
