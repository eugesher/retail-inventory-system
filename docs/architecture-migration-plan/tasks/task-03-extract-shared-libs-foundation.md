# task-03 — Extract shared libs: foundation (Phase 1, part 1)

## Context

- Migration plan: `docs/architecture-migration-plan/parts/recommendation.md`
- Conventions preamble: `docs/architecture-migration-plan/tasks/task-01-review-project-and-update-plan.md`
- Previous carryover: `docs/architecture-migration-plan/tasks/_carryover-02.md`
- Project conventions: `CLAUDE.md`
- Where we are in the migration: baseline captured. The repository has
  four libs already — `libs/common`, `libs/config`, `libs/inventory`,
  `libs/retail` — partially split along service lines. This task
  introduces the **foundation** libs the rest of the migration
  depends on (`libs/contracts`, `libs/database`, slimmed `libs/common`).
  Other apps depend on these foundation libs, so they must land
  before task-04 (integration libs) or task-05+ (apps). Path-alias
  prefix throughout is `@retail-inventory-system/<name>` per
  `_carryover-01.md`.

## Prerequisites

- [ ] `_carryover-02.md` exists and was read first.
- [ ] Build is green on entry.

## Goal

Establish the three foundation libraries that the rest of the migration
depends on:

- `@retail-inventory-system/contracts` — cross-service message and DTO
  contracts (plain TypeScript only, no Nest decorators).
- `@retail-inventory-system/database` — TypeORM base entity, base
  repository, snake-naming strategy re-export, `DatabaseModule`.
- a slimmed `@retail-inventory-system/common` that holds **only**
  framework-free utilities (types, Result, exceptions, pagination).

App code under `apps/*/src/` is not refactored in this task — only the
import paths change so the apps still compile against the new lib
layout. The integration libs (`messaging`, `cache`, `observability`,
`ddd`) are deferred to task-04. `libs/auth` is built fresh in
task-06 — do not stub it here.

## Steps

1. **Plan the split.** Read `libs/common/`, `libs/config/`,
   `libs/retail/`, `libs/inventory/` end-to-end. Produce a mapping
   table: for each existing exported symbol, write its new home
   (`libs/contracts/<service>/`, `libs/database/`, `libs/common/`, or
   "deferred to task-04 (`messaging`/`cache`/`observability`/`ddd`)").
   Save the table to `_carryover-03.md`. Do **not** start moving code
   until the table is complete.

2. **Create `libs/contracts/`** as a Nest library
   (`yarn nest g library contracts`; if Yarn 4's `pnpify`/PnP
   interferes, hand-create `libs/contracts/{src,tsconfig.lib.json}`
   and add an entry under `nest-cli.json` `projects` mirroring the
   existing libs). Move into `libs/contracts/src/<service>/`:
   - From `libs/common/enums/`: `microservice-message-pattern.enum.ts`,
     `microservice-queue.enum.ts`, `microservice-client-token.enum.ts`,
     `app-name.enum.ts`. Routing-key migration to dotted
     `<service>.<aggregate>.<event>` is task-04's responsibility;
     this task only moves the existing enum to its new home.
   - From `libs/common/interfaces/`:
     `order-product-confirm.interface.ts`.
   - From `libs/inventory/`: every type under `product-stock/` plus
     `inventory.constants.ts` → `libs/contracts/src/inventory/`.
   - From `libs/retail/`: every DTO/enum/interface →
     `libs/contracts/src/retail/`.

3. **Create `libs/database/`** as a Nest library. Add or relocate:
   - `base.entity.ts` — abstract class with `id`, `createdAt`,
     `updatedAt`, `deletedAt` columns. **New**. Decide id strategy
     (uuid vs autoincrement) in this task and record in the ADR; the
     existing entities use auto-increment integers, so default to
     that and document the trade-offs.
   - `base-typeorm.repository.ts` — generic
     `BaseTypeormRepository<TEntity, TDomain>` with `find`, `save`,
     `softDelete`, and a mapper hook. **New**.
   - `snake-naming.strategy.ts` — re-export
     `typeorm-naming-strategies`'s `SnakeNamingStrategy`.
   - `database.module.ts` — relocate the `TypeormModuleConfig`
     factory from `libs/config/typeorm-module.config.ts`. Wraps
     `TypeOrmModule.forRootAsync()` reading `DATABASE_URL` from
     `@nestjs/config`, applying `SnakeNamingStrategy`, and exposing
     `forFeature()` to consumers. The existing class name
     `TypeormModuleConfig` is preserved for one release as a
     re-export from `libs/config` to ease the migration; remove the
     re-export in task-14.
   - Existing migrations under `migrations/` (top-level) are **not**
     moved — `migrations/config/data-source.ts` keeps its current
     path, and the library does not own migration files.

4. **Slim `libs/common/`.** Keep only framework-free utilities:
   - `result.ts` (a `Result<T, E>` type if/when needed) — **new**.
   - `exceptions/` — domain-error base classes only, no `HttpException`
     — **new** (no current contents).
   - `pagination/` — page/size/cursor helpers — **new**.
   - `types/` — shared TypeScript types — **new**.
   Move out everything else: enums to `libs/contracts/<service>/`,
   correlation-ID utilities to `libs/observability` (task-04), cache
   helpers to `libs/cache` (task-04), microservice client modules to
   `libs/messaging` (task-04). Anything moved out gets a one-release
   re-export shim in `libs/common/index.ts` (deleted in task-14).

5. **Update path aliases.** Add to `tsconfig.json` `paths`:
   - `@retail-inventory-system/contracts` → `libs/contracts`
   - `@retail-inventory-system/database` → `libs/database`
   Do not remove the existing `common`/`config`/`inventory`/`retail`
   aliases yet — the apps still depend on them. Mirror the additions
   in `jest.unit.config.js`, `jest.e2e.config.js`, and `nest-cli.json`'s
   `projects` block.

6. **Update import sites under `apps/`.** Repoint every import that
   referenced a moved symbol — `find` + `sed`, then `yarn build` to
   confirm. The apps must still compile. Any moved symbol with a
   re-export shim from step 4 keeps its old import path working so
   this step is mostly cosmetic.

7. **Update each microservice's `*.module.ts`** so anything that
   previously imported `TypeormModuleConfig` from
   `@retail-inventory-system/config` now imports `DatabaseModule`
   from `@retail-inventory-system/database` (or keeps the
   `TypeormModuleConfig` shim — pick one and document in
   `_carryover-03.md`).

8. **Verify** the apps still build and unit tests still pass.

## Documentation updates required

- [ ] `README.md`: under a new "Shared libraries" section, document
  the new lib layout: `contracts`, `database`, `common`, plus a
  forward pointer to `messaging`, `cache`, `observability`, `ddd`
  added in task-04 and `auth` added in task-06.
- [ ] `CLAUDE.md`: update the "Shared Libraries" block to list the
  new lib names and their import aliases. Strike the
  "Inventory DTOs and interfaces" / "Retail DTOs, enums and
  interfaces" descriptions — those types now live in
  `@retail-inventory-system/contracts/<service>/`.
- [ ] `docs/adr/NNN-split-shared-common-into-bounded-libs.md`:
  new ADR (3-digit, next free) recording the decision and the new
  lib responsibilities.

## Verification

- [ ] `yarn install` succeeds.
- [ ] `yarn build` succeeds for all four apps.
- [ ] `yarn lint` succeeds.
- [ ] `yarn test:unit` succeeds.
- [ ] `libs/contracts`, `libs/database`, `libs/common` exist with the
  shapes described in steps 2–4.
- [ ] No app code under `apps/*/src/` was modified beyond import-path
  rewrites — `git diff --stat` shows contracts/database/common files
  as new, apps as small import-only edits.

## Carryover

Write `_carryover-03.md` with:
- The full export-mapping table from step 1.
- New lib filenames and their re-exports.
- List of import sites updated under `apps/`.
- Anything that was **not** moved and the reason (e.g., a symbol
  that belongs in `libs/messaging` and is deferred to task-04).
- Whether `TypeormModuleConfig` was renamed or kept as a shim.
- The 3-digit ADR number assigned for the lib-split decision.
- Verification results.
- Suggested adjustments to task-04 (it depends directly on this
  task's output).
