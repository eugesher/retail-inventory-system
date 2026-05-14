# _carryover-14.md — Cleanup, polish, and propose release tag (Phase 8, final)

> Generated 2026-05-14 by the task-14 session on branch
> `RIS-38-Architecture-migration-Phase-14-Cleanup-polish-and-propose-release-tag`.
> This is the **last** carryover. After the human applies the tag and
> merges, the carryover plus the entire `tasks/` folder is removed in
> a follow-up commit (the no-Git-ops rule keeps that out of the AI
> session — see step 9 of `task-14-cleanup-and-tag.md`).

Branch HEAD entering the session: `b3fb327 RIS-37 Architecture migration. Phase 13: Back-fill structural architecture ADRs (#32)`.

## 1. Entry-gate result

```
$ yarn install   — Done in 2s 307ms
$ yarn build     — 4 apps compiled successfully (webpack 5.106.0)
$ yarn lint      — clean (exit 0)
$ yarn test:unit — 29 suites / 152 tests passed
```

`yarn test:e2e` was deferred to the final-verification step (it
double-counts as the run that validates the shim removal end-to-end).

## 2. Deprecation shims removed

| Path | Why it was a shim | Replacement |
| ---- | ----------------- | ----------- |
| `libs/inventory/` (whole package) | Re-exported `@retail-inventory-system/contracts` per ADR-005's transition window. | Import from `@retail-inventory-system/contracts` directly. |
| `libs/retail/` (whole package) | Re-exported `@retail-inventory-system/contracts` per ADR-005's transition window. | Import from `@retail-inventory-system/contracts` directly. |
| `libs/common/cache/` (`cache.helper.ts` + `index.ts`) | Re-exported `CacheHelper` from `@retail-inventory-system/cache`. | Import from `@retail-inventory-system/cache`. |
| `libs/common/correlation/` (5 files) | Re-exported `CorrelationMiddleware`, `CorrelationId`, `CORRELATION_ID_HEADER`, `ICorrelationPayload` from `@retail-inventory-system/observability`. | Import from `@retail-inventory-system/observability`. |
| `libs/common/modules/` (3 files) | Re-exported `MicroserviceClient{Retail,Inventory}Module` from `@retail-inventory-system/messaging`. | Import from `@retail-inventory-system/messaging`. |
| `libs/common/config/` (2 files) | Re-exported `MicroserviceClientConfiguration` from `@retail-inventory-system/messaging`. (Not enumerated in CLAUDE.md's shim list but inspection confirmed pure re-export.) | Import from `@retail-inventory-system/messaging`. |
| `libs/config/cache-module.config.ts` | Re-exported `cacheModuleConfig` from `@retail-inventory-system/cache`. | `cacheModuleConfig` is internal to `libs/cache` and consumed only by `CacheModule` — no app-side caller. |
| `libs/config/logger-module.config.ts` | Re-exported `LoggerModuleConfig` from `@retail-inventory-system/observability`. | Import from `@retail-inventory-system/observability`. |
| `libs/config/typeorm-module.config.ts` | Documented as a shim pointing at `DatabaseModule.forRoot()` but actually still held a real implementation. Zero consumers in the tree. | `DatabaseModule.forRoot(entities)` from `@retail-inventory-system/database`. |
| `libs/common/index.ts` (contracts re-export block) | Forwarded `AppNameEnum`, `IOrderProductConfirm`, `MicroserviceClientTokenEnum`, `MicroserviceMessagePatternEnum`, `MicroserviceQueueEnum` from `@retail-inventory-system/contracts`. | Import from `@retail-inventory-system/contracts`. |

### Configuration ripples

- `tsconfig.json` — removed `@retail-inventory-system/inventory` and `@retail-inventory-system/retail` path aliases.
- `eslint.config.mjs` — dropped the `lib-shim` element-type entry (with its eight shim path patterns) and the corresponding `from: { type: 'lib-shim' }` allow rule. The remaining boundaries config is unchanged.
- `libs/common/index.ts` — slimmed to four re-exports (`exceptions`, `pagination`, `result`, `types`); shim block + contracts forwarding block deleted.
- `libs/config/index.ts` — slimmed to a single re-export (`config-module.config`).

### Test-file ripples

Initial e2e run after the shim removal surfaced three stale imports under `test/` (not under `tests/`, which I had checked). Fixed in this same session:

- `test/auth.e2e-spec.ts:9` — `MicroserviceQueueEnum` re-routed from `@retail-inventory-system/common` → `@retail-inventory-system/contracts`.
- `test/system-api.e2e-spec.ts:12-13` — `MicroserviceQueueEnum` + `ProductStockGetResponseDto` re-routed to `@retail-inventory-system/contracts`; `CORRELATION_ID_HEADER` re-routed to `@retail-inventory-system/observability`.

## 3. Dead code removed

### Files

- `apps/api-gateway/src/modules/auth/application/dto/current-user.view.ts` — defined `ICurrentUserView` with zero consumers anywhere in the tree. CLAUDE.md referenced it as if `JwtStrategy` used it, but the runtime current-user contract is `ICurrentUser` from `@retail-inventory-system/contracts/auth` (re-exported by `@retail-inventory-system/auth`). Index re-export also removed (`apps/api-gateway/src/modules/auth/application/dto/index.ts`).

### Empty directories (manual removal per task-14 step 2)

- `apps/api-gateway/test/`, `apps/inventory-microservice/test/`, `apps/notification-microservice/test/`, `apps/retail-microservice/test/` — vestigial scaffolding from `nest new`; all e2e specs live at the repo root under `test/`. Each app's `tsconfig.app.json` keeps `"test"` in its `exclude` array (functionally a no-op now); leaving the entries untouched avoids cosmetic churn on stable config files.
- `apps/inventory-microservice/src/modules/stock/application/dto/`, `apps/inventory-microservice/src/modules/stock/presentation/dto/` — empty placeholders. Wire-format DTOs for the stock context live in `libs/contracts/inventory/`.

### `*.service.ts` sweep

`find apps -name '*.service.ts' -not -path '*/node_modules/*'` — empty. The hexagonal migration already replaced the pre-migration `*.service.ts` files with `*.use-case.ts`.

## 4. `(verify in task-01)` annotations + `TODO(human)` tokens

Both verification gates pass cleanly for the durable surfaces:

```
$ grep -n '(verify in task-01)' CLAUDE.md README.md
(no matches)
$ grep -rn '(verify in task-01)' docs/adr/
(no matches)
$ grep -r 'TODO(human)' apps/ libs/ docs/adr/
(no matches)
```

Two transitional-doc hits remain inside `docs/architecture-migration-plan/`:

| Path | Hit | Disposition |
| ---- | --- | ----------- |
| `docs/architecture-migration-plan/tasks/task-14-cleanup-and-tag.md` | 3 self-references (task brief describing the verification gate) | Deleted with the rest of `tasks/` in the human's post-merge follow-up commit. |
| `docs/architecture-migration-plan/parts/migration-checklist.md` line 313 | 1 line — meta-text describing the gate itself, **not** an annotation to resolve | The `parts/` folder is preserved as historical record (referenced from the README). The literal string survives only as a description of what task-14 verified; no annotation it points at exists anywhere in the durable surface. Left untouched. |

## 5. README/CLAUDE.md final-state diff (summary)

### `README.md` (+91 / −37 net)

- **Migration banner replaced.** The "Architecture migration in progress" section is gone. The new "Architecture" lead paragraph describes the per-module hexagonal layout in two sentences and points at `docs/adr/index.md`. The `docs/architecture-migration-plan/parts/` link is preserved as a historical pointer (the migration checklist + recommendation document outlive the task queue).
- **Top-level system diagram refreshed.** Added `/api/auth/*` routes, the Redis cache-aside box on the inventory side, a footnote pointing at the OpenTelemetry + Jaeger flow, and renamed "Retail DB" → "Shared DB" with the full table list (was only retail-side tables). The diagram now visibly contains all four services plus RabbitMQ, MySQL, Redis, and Jaeger as required by task-14 step 4.
- **Shared-libraries table polished.** Dropped four shim rows (`inventory`, `retail`, the `common` shim caveat, the `config` shim caveat). Updated `contracts` to mention the `auth/` sub-area. Updated `observability` to drop the "filled in task-10" parenthetical and call out the active `tracer.ts` instead of a "shell".
- **Layout sections corrected.** Removed "Microservices remain on the legacy flat layout until tasks 07–09 of the migration" and "task-06 will add `modules/auth/`" — both were pre-migration future-tense statements.
- **Scripts section reorganised** into Development / Build / Lint / Database migrations / Testing tables. Every command in `package.json` is now listed with a one-line description (task-14 step 4).
- **Tracer-import-first paragraph** dropped the "an eslint rule may follow in task-12" footnote (task-12 shipped boundaries rules, not import-order rules) and replaced it with a forward-looking pointer to a future import-order rule.

### `CLAUDE.md` (+18 / −28 net)

- **Architecture tree** dropped the `inventory/`, `retail/`, and the "shim" annotations on `common/` and `config/`.
- **Shared Libraries section** dropped the `common` shim caveat, the `config` shim list, the `inventory`/`retail` shim row, and the legacy `TypeormModuleConfig` mention. `common`'s entry now lists the actual exported symbols.
- **"Architecture migration" section retired.** The "Architecture rules location", "Baseline snapshot", and the four open-item bullets are kept; the "No-Git-ops rule" + "Carryover-file pattern" subsections (which were migration-workflow notes) are removed.
- **"Known Issues" renamed to "Operational notes".** Same content but trimmed of the "task-11 closed", "was already wired in task-08" sentences. Added one bullet for ARCH-LINT-EX-01 (the EntityManager port leak called out in `_carryover-13.md` §9).
- Two stale "(added in task-06)" / "(task-07/08/09)" parenthetical attributions removed from the per-service descriptions.

## 6. Final ADR index

`docs/adr/index.md` is unchanged in task-14 (the catalogue stabilised in task-13). For completeness:

```
$ ls docs/adr/0*.md | wc -l
20
$ grep -rhEo 'ADR-?[0-9]+' docs/adr/ | sort -u
ADR-001 … ADR-020   (no gap, no dangling reference)
```

Status: every ADR `Accepted`; no ADR currently `Superseded`. Next free slot is **ADR-021**.

## 7. Proposed release tag

| Field | Proposal |
| ----- | -------- |
| **Tag name** | `v1.0.0-architecture` |
| **Why this name** | First "shippable" snapshot of the post-migration architecture. Semver `1.0.0` because the public service contracts (HTTP routes + RabbitMQ routing keys) have a stable shape now and the per-module hexagonal layout is the contract every later change preserves. The `-architecture` suffix labels the milestone as "architecture-stabilization" rather than a product release — the codebase is portfolio-stage, not customer-facing. |
| **Merge strategy** | **Squash-merge** the phase-14 PR into `main`. Each phase already landed as its own PR with a phase-scoped commit message, so the migration is fully readable by walking `main`'s history (`git log --oneline --grep 'Architecture migration. Phase'`). Squashing the cleanup PR keeps that pattern consistent for phase-14. |
| **Suggested release notes** | See block below — paste into `gh release create v1.0.0-architecture --notes-file …` or the GitHub UI. |

### Suggested release notes

```markdown
## Architecture migration — v1.0.0

This release closes a 14-phase migration that converted the codebase
from a flat Brocoders-style scaffold into a per-module hexagonal
(ports & adapters) NestJS monorepo. The shape every later change will
preserve is now in place.

### What landed

- **Per-module hexagonal layout** in every service. `domain/` is
  framework-free; `application/` exposes use-cases + port interfaces;
  `infrastructure/` holds the concrete adapters (TypeORM, RabbitMQ,
  Redis); `presentation/` holds HTTP controllers and `@MessagePattern`
  handlers. The boundaries are enforced by `eslint-plugin-boundaries`
  with a fixture-based regression spec (ADR-017).
- **Auth at the gateway.** JWT (HS256, rotated refresh with reuse
  detection) + argon2id passwords + global `JwtAuthGuard` / `RolesGuard`
  + `@Public()` / `@Roles()` / `@CurrentUser()` decorators. The auth
  module is the first gateway module with a real `domain/` and owns
  its own DB state (ADR-010).
- **Notification microservice** built from scratch as the canonical
  per-module template; ports outbound delivery behind `NOTIFIER`
  (log adapter today; email + webhook scaffolded) (ADR-011).
- **Cache-aside generalised.** Keys follow
  `ris:<service>:<aggregate>:<id>[:<facet>]`; the cache port exposes a
  `delByPrefix` primitive that wipes mutated aggregates SCAN+UNLINK
  style; invalidation is awaited post-commit so the next read sees
  fresh data (ADR-016).
- **OpenTelemetry + Jaeger.** Every service exports OTLP/HTTP spans
  through the `otel-collector` container; the amqplib hook propagates
  `traceparent` so a single trace covers gateway → retail → inventory
  → notification. Pino log lines emitted inside an active span carry
  `traceId` / `spanId` (ADR-014, ADR-015).
- **Bounded libs.** The fat `libs/common` was carved into
  `libs/{contracts,database,ddd,messaging,cache,observability,config,
  auth}`; cross-lib imports are restricted by the boundaries rules
  (ADR-005, ADR-017).

### What was retired

- Pre-migration `*.service.ts` files (replaced by `*.use-case.ts`).
- All one-release deprecation shims under `libs/common/`,
  `libs/config/`, `libs/inventory/`, `libs/retail/` (removed in phase
  14).
- The dead `ICurrentUserView` interface in the gateway's auth module.

### ADRs

The full catalogue is at [`docs/adr/index.md`](../docs/adr/index.md)
— 20 ADRs covering everything from the monorepo baseline (ADR-018) to
the architecture-lint regression suite (ADR-017).
```

## 8. Verification results

```
$ yarn --version
4.12.0
$ node --version
v24.13.1

$ yarn install
➤ YN0000: · Yarn 4.12.0
➤ YN0000: ┌ Resolution step
➤ YN0000: └ Completed in 0s 396ms
➤ YN0000: ┌ Fetch step
➤ YN0000: └ Completed in 1s 241ms
➤ YN0000: ┌ Link step
➤ YN0000: └ Completed in 0s 595ms
➤ YN0000: · Done in 2s 337ms

$ yarn build
webpack 5.106.0 compiled successfully in 7149 ms
webpack 5.106.0 compiled successfully in 8328 ms
webpack 5.106.0 compiled successfully in 8471 ms
webpack 5.106.0 compiled successfully in 10003 ms

$ yarn lint
(no output — exit 0)

$ yarn test:unit
Test Suites: 29 passed, 29 total
Tests:       152 passed, 152 total
Snapshots:   0 total
Time:        42.333 s
Ran all test suites.

$ yarn test:e2e            # ran test:infra:reload + test:e2e:run
# After fixing the three stale shim imports under test/, the e2e run reported:
Test Suites: 3 passed, 3 total
Tests:       35 passed, 35 total
Snapshots:   42 passed, 42 total
Time:        17.185 s
Ran all test suites.
```

(`test:e2e` first failed because `test/auth.e2e-spec.ts` and
`test/system-api.e2e-spec.ts` were still importing from the deleted
`@retail-inventory-system/common` and `@retail-inventory-system/inventory`
shims — my initial shim-consumer grep had scanned `tests/` instead of
both `test/` + `tests/`. The two test files were updated in this same
task to import from the canonical libs, after which all three suites
pass.)

### Verification-gate checklist (from `task-14-cleanup-and-tag.md`)

- [x] `yarn install` succeeds.
- [x] `yarn build` succeeds for all four apps.
- [x] `yarn lint` succeeds.
- [x] `yarn test:unit` succeeds.
- [x] `yarn test:e2e` succeeds.
- [ ] `docs/architecture-migration-plan/tasks/` no longer exists at
      task end — **deferred to the human's post-merge cleanup commit**
      per the task brief ("the AI session does **not** make the
      deletion commit").
- [x] No `(verify in task-01)` strings remain anywhere in `README.md`
      or `CLAUDE.md`. (Two transitional hits inside
      `docs/architecture-migration-plan/` remain; both are accounted
      for in §4 above and neither is an unresolved annotation.)
- [x] `grep -r 'TODO(human)' apps/ libs/ docs/adr/` returns empty.

## 9. Suggested follow-up tasks (post-merge)

These are deliberately scoped post-merge — none of them blocks
v1.0.0-architecture. They are listed in roughly the order they would
deliver the most leverage:

1. **Password reset + email verification flow.** The auth module today
   has Login / Refresh / Logout / Register; password-reset is the
   natural next slice and would exercise the existing notification
   microservice (a single new `auth.password-reset.requested` event
   plus a new email-template handler).
2. **Rate limiting on `/auth/login`.** Today there is no throttle on
   the login route — a brute-force lockout (per-IP and per-email) is
   table stakes before this goes anywhere customer-facing.
3. **Close ARCH-LINT-EX-01.** Introduce an `ITransactionPort` in the
   stock module so `stock.repository.port.ts` no longer needs to import
   `EntityManager` directly. The change is small enough to ship under
   a refinement of ADR-004 / ADR-012; no new ADR strictly required.
4. **Deploy Jaeger + OTel collector to a staging cluster.** The local
   compose overlay is enough for dev work but the value of distributed
   tracing only lands once a real environment runs it continuously.
5. **Close the remaining cache audit items.** `CACHE-001` (read/write
   race), `CACHE-003` (schema-version segment in keys), `CACHE-004`
   (TTL jitter), `CACHE-005` (duplicate warn logs on Redis-down) — see
   `docs/audits/audit-2026-05-08.md` for the recipe each one expects.
6. **Multi-tenant cache prefix (CACHE-009).** When (if) the system
   gains a tenant axis, generalise the key convention to
   `ris:<tenant>:<service>:<aggregate>:<id>[:<facet>]`. Touches
   `libs/cache/cache-keys.ts` + every builder caller; cleanly
   forward-compatible because the current keys would be
   `ris:default:<service>:<aggregate>:<id>` under the new shape.
7. **Retire the legacy `stock:<productId>:*` cache prefix.** Per ADR-016,
   the legacy builder + its invalidation pass stay around through the
   first post-merge deploy so any in-flight cached entries from the
   pre-migration prefix are flushed. After one production deploy, the
   builder + its caller in the reserve-stock invalidation loop can be
   deleted.
8. **Introduce a `retail-products` bounded context** if/when product
   master-data becomes a first-class concern. The retail microservice
   currently treats products as foreign-key references; if business
   needs admin CRUD over products (categories, pricing, etc.), this
   is where a new module slots in cleanly.
9. **Import-order ESLint rule.** Codify the "first import in `main.ts`
   must be the tracer" rule that's enforced by review today (ADR-014
   / ADR-007). Either a custom rule or a configured
   `eslint-plugin-import` `import/order` setup would close the
   loophole the boundaries rules can't see.

## 10. Final state — what the human does next

1. **Review and commit** the working-tree changes (see `git status`
   inside the branch). The intended commit subject is something along
   the lines of: `RIS-38 Architecture migration. Phase 14: Cleanup,
   polish, and propose release tag`. The diff is small (+91 / −272
   net lines, mostly deletions of shim files); a single commit is the
   right unit.
2. **Open the PR** for the phase-14 branch and run `/ultrareview` as
   you have on every previous phase if you want a final independent
   read on it.
3. **Merge** with squash (rationale in §7).
4. **Tag the merge commit** with `v1.0.0-architecture` (proposed name
   in §7; bump or replace if you prefer a different scheme). Push the
   tag, create the GitHub release with the suggested notes.
5. **Delete the migration scratch.** In a follow-up commit on `main`
   (the no-Git-ops rule keeps this out of the AI session):
   - `rm -rf docs/architecture-migration-plan/tasks/`
   - Optionally `rm docs/architecture-migration-plan/parts/migration-checklist.md`
     if you'd rather not have the `(verify in task-01)` string survive
     a grep (purely cosmetic — the line is meta-text, not an
     unresolved marker).
   The carryover files plus the migration plan README and
   recommendation document can stay under `parts/` as a historical
   record (referenced from `README.md`).

The migration is complete.
