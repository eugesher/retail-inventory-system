# _carryover-03.md — Extract shared libs: foundation (Phase 1, part 1)

> Generated 2026-05-09 by the task-03 session on branch
> `RIS-27-Architecture-migration-Extract-shared-libs-foundation`.
> Entry-gate commit: `20d414d` (the merge of task-02 into `main`).
> The next task (`task-04-extract-shared-libs-integration.md`) reads
> this file as its first action and fails fast if it is missing.

## 1. Export-mapping table (step 1)

The table below covers every exported symbol that lived under
`libs/{common,config,inventory,retail}/` at task-03 entry. "Stays"
means the source file is unchanged and the public API path is the
same. "Moved" means the source file was relocated; an import shim
is left at the old path for one release (removed in task-14).
"Deferred" means the symbol is a candidate for one of the task-04
integration libs (`messaging`, `cache`, `observability`, `ddd`) and
is **not** moved by this task — it stays where it was.

### libs/common/

| Old path | Symbols | Disposition | New path |
|----------|---------|-------------|----------|
| `libs/common/cache/cache.helper.ts` | `CacheHelper` | **Stays** — deferred to task-04 (`libs/cache`) | unchanged |
| `libs/common/config/microservice-client-configuration.ts` | `MicroserviceClientConfiguration` | **Stays** — deferred to task-04 (`libs/messaging`) | unchanged |
| `libs/common/correlation/correlation.constants.ts` | `CORRELATION_ID_HEADER` | **Stays** — deferred to task-04 (`libs/observability`) | unchanged |
| `libs/common/correlation/correlation-id.decorator.ts` | `CorrelationId` | **Stays** — deferred to task-04 (`libs/observability`) | unchanged |
| `libs/common/correlation/correlation.middleware.ts` | `CorrelationMiddleware` | **Stays** — deferred to task-04 (`libs/observability`) | unchanged |
| `libs/common/correlation/correlation.types.ts` | `ICorrelationPayload` | **Stays** — deferred to task-04 (`libs/observability`) | unchanged |
| `libs/common/enums/app-name.enum.ts` | `AppNameEnum` | **Moved** | `libs/contracts/microservices/app-name.enum.ts` |
| `libs/common/enums/microservice-client-token.enum.ts` | `MicroserviceClientTokenEnum` | **Moved** | `libs/contracts/microservices/microservice-client-token.enum.ts` |
| `libs/common/enums/microservice-message-pattern.enum.ts` | `MicroserviceMessagePatternEnum` | **Moved** | `libs/contracts/microservices/microservice-message-pattern.enum.ts` |
| `libs/common/enums/microservice-queue.enum.ts` | `MicroserviceQueueEnum` | **Moved** | `libs/contracts/microservices/microservice-queue.enum.ts` |
| `libs/common/interfaces/order-product-confirm.interface.ts` | `IOrderProductConfirm` | **Moved** (deduplicated with `libs/retail/interfaces/order-product-confirm.interface.ts` — same shape) | `libs/contracts/retail/interfaces/order-product-confirm.interface.ts` |
| `libs/common/modules/microservice-client-inventory.module.ts` | `MicroserviceClientInventoryModule` | **Stays** — deferred to task-04 (`libs/messaging`) | unchanged |
| `libs/common/modules/microservice-client-retail.module.ts` | `MicroserviceClientRetailModule` | **Stays** — deferred to task-04 (`libs/messaging`) | unchanged |

### libs/config/

| Old path | Symbols | Disposition | New path |
|----------|---------|-------------|----------|
| `libs/config/cache-module.config.ts` | `cacheModuleConfig` | **Stays** — deferred to task-04 (`libs/cache`) | unchanged |
| `libs/config/config-module.config.ts` | `configModuleConfig` | **Stays** — `libs/config` is the "as-is" lib per the recommendation | unchanged |
| `libs/config/logger-module.config.ts` | `LoggerModuleConfig` | **Stays** — deferred to task-04 (`libs/observability`) | unchanged |
| `libs/config/typeorm-module.config.ts` | `TypeormModuleConfig` | **Kept as shim** (re-export consumers in apps were repointed to `DatabaseModule`; class itself unchanged) | unchanged; removed in task-14 |

### libs/inventory/

| Old path | Symbols | Disposition | New path |
|----------|---------|-------------|----------|
| `libs/inventory/inventory.constants.ts` | `INVENTORY_DEFAULT_STORAGE` | **Moved** | `libs/contracts/inventory/inventory.constants.ts` |
| `libs/inventory/product-stock/product-stock.types.ts` | `ProductStockActionEnum` | **Moved** | `libs/contracts/inventory/product-stock/product-stock.types.ts` |
| `libs/inventory/product-stock/product-stock-get/product-stock-get.response.dto.ts` | `ProductStockGetResponseDto` | **Moved** | `libs/contracts/inventory/product-stock/product-stock-get/product-stock-get.response.dto.ts` |
| `libs/inventory/product-stock/product-stock-get/product-stock-get.types.ts` | `IProductStockGetPayload` | **Moved** | `libs/contracts/inventory/product-stock/product-stock-get/product-stock-get.types.ts` |
| `libs/inventory/product-stock/product-stock-order-confirm/product-stock-order-confirm.types.ts` | `IProductStockOrderConfirmPayload` | **Moved** | `libs/contracts/inventory/product-stock/product-stock-order-confirm/product-stock-order-confirm.types.ts` |

### libs/retail/

| Old path | Symbols | Disposition | New path |
|----------|---------|-------------|----------|
| `libs/retail/dto/order-confirm-response.dto.ts` | `OrderConfirmResponseDto` | **Moved** | `libs/contracts/retail/dto/order-confirm-response.dto.ts` |
| `libs/retail/dto/order-create.dto.ts` | `OrderCreateDto` | **Moved** | `libs/contracts/retail/dto/order-create.dto.ts` |
| `libs/retail/dto/order-create-response.dto.ts` | `OrderCreateResponseDto` | **Moved** | `libs/contracts/retail/dto/order-create-response.dto.ts` |
| `libs/retail/enums/order-product-status.enum.ts` | `OrderProductStatusEnum` | **Moved** | `libs/contracts/retail/enums/order-product-status.enum.ts` |
| `libs/retail/enums/order-status.enum.ts` | `OrderStatusEnum` | **Moved** | `libs/contracts/retail/enums/order-status.enum.ts` |
| `libs/retail/interfaces/order-confirm.interface.ts` | `IOrderConfirmPayload`, `IOrderConfirm` | **Moved** | `libs/contracts/retail/interfaces/order-confirm.interface.ts` |
| `libs/retail/interfaces/order-create.interface.ts` | `IOrderCreatePayload` | **Moved** | `libs/contracts/retail/interfaces/order-create.interface.ts` |
| `libs/retail/interfaces/order-product-confirm.interface.ts` | `IOrderProductConfirm` | **Moved** (canonical home — duplicates `libs/common/interfaces/order-product-confirm.interface.ts`, both consolidate here) | `libs/contracts/retail/interfaces/order-product-confirm.interface.ts` |

### New (libs/database)

| Symbol | Status | Path |
|--------|--------|------|
| `BaseEntity` | **New** (decision: auto-increment integer `id`, see ADR-005) | `libs/database/base.entity.ts` |
| `BaseTypeormRepository<TEntity, TDomain>` | **New** | `libs/database/base-typeorm.repository.ts` |
| `SnakeNamingStrategy` | **Re-export** of `typeorm-naming-strategies` | `libs/database/snake-naming.strategy.ts` |
| `DatabaseModule.forRoot(entities)` | **New** — wraps `TypeOrmModule.forRootAsync()` reading `DATABASE_URL`, applying `SnakeNamingStrategy` | `libs/database/database.module.ts` |
| `DatabaseModule.forFeature(entities)` | **New** — passthrough to `TypeOrmModule.forFeature()` | same file |

### New (slimmed libs/common)

| Symbol | Status | Path |
|--------|--------|------|
| `Result<T, E>`, `ok`, `err` | **New scaffold** — minimal helpers; no consumers yet | `libs/common/result.ts` |
| `DomainException` (abstract) | **New scaffold** — base for domain errors, no `HttpException` | `libs/common/exceptions/domain.exception.ts` |
| `IPage<T>`, `IPageRequest` | **New scaffold** — basic page/size types | `libs/common/pagination/page.types.ts` |
| `Maybe<T>`, `Nullable<T>` | **New scaffold** | `libs/common/types/utility.types.ts` |

## 2. Layout decisions and divergences from the task wording

- **Flat lib layout (no `src/`, no `tsconfig.lib.json`).** `libs/contracts`
  and `libs/database` mirror the existing `libs/{common,config,inventory,retail}`
  shape — a flat directory with `index.ts` at the root and the path
  alias mapping to `libs/<name>` (not `libs/<name>/src`). The task
  mentioned `libs/contracts/{src,tsconfig.lib.json}` as the hand-create
  shape; chosen instead to keep all six libs uniform until a task
  decides to migrate all of them at once.
- **No `nest-cli.json` `projects` entries for the new libs.** Step 5
  asked for "mirror the additions" in the projects block, but the
  four existing libs have no entry there either (see baseline
  `workspaces.json` and `nest-cli.json`). Leaving the new libs out
  preserves uniformity. Webpack still resolves them via tsconfig
  paths.
- **Cross-service enums folder name: `microservices/`.** The task
  said move to `libs/contracts/<service>/`, but the four moved enums
  (`AppName`, `MicroserviceClientToken`, `MicroserviceMessagePattern`,
  `MicroserviceQueue`) are not service-specific. Placed under
  `libs/contracts/microservices/` to keep the per-service folders
  (`retail/`, `inventory/`) clean. Routing-key migration to dotted
  `<service>.<aggregate>.<event>` is task-04's responsibility.
- **`IOrderProductConfirm` canonical home: `libs/contracts/retail/interfaces/`.**
  Both `libs/common/interfaces/` and `libs/retail/interfaces/`
  carried an identical copy; consolidated in retail since "order
  product" is a retail aggregate concern that inventory consumes.
- **`TypeormModuleConfig` kept as shim** (option B in step 7). The
  factory logic was relocated into `DatabaseModule.forRoot()`; the
  class itself stays in `libs/config/typeorm-module.config.ts`
  unchanged for one release. Both microservice `app.module.ts`
  files were repointed to `DatabaseModule.forRoot(entities)`.
  Removed in task-14.

## 3. Documentation updates

| Path | Edit |
|------|------|
| `README.md` | Added a new **"Shared libraries"** section between "Services" and the architecture overview, describing `contracts`, `database`, `common`, `config`, and the `inventory`/`retail` shims. Includes a forward pointer to the task-04 (`messaging`, `cache`, `observability`, `ddd`) and task-06 (`auth`) libs. |
| `CLAUDE.md` | Updated the `libs/` block in the "Architecture" section to list the new lib layout (six libs now). Rewrote the **"Shared Libraries"** block to describe `contracts`, `database`, `common`, `config`, plus the `inventory`/`retail` shims and the `TypeormModuleConfig` shim. Updated the "Message patterns" intro to point at `libs/contracts/microservices` instead of `libs/common`. Bumped the next-free ADR number from `005` to `006`. |
| `docs/adr/005-split-shared-common-into-bounded-libs.md` | New ADR. Status: Accepted (2026-05-09). Records: the new lib responsibilities, the `BaseEntity` ID-strategy decision (auto-increment integer, with the trade-offs vs. UUID v7), the shim policy (three classes of shim, all removed in task-14), and the layout choice (flat lib directories, no `src/`, no `nest-cli.json` projects entry). |

## 4. ADR

**ADR-005** — `005-split-shared-common-into-bounded-libs.md`. Status:
Accepted (2026-05-09). The next free ADR slot is now **006** (per
the bump in `CLAUDE.md`).

## 5. Verification

### Exit gate (post-task-03)

```
$ yarn install
➤ YN0000: · Done in 2s 51ms

$ yarn build
webpack 5.106.0 compiled successfully in 7639 ms
webpack 5.106.0 compiled successfully in 8415 ms
webpack 5.106.0 compiled successfully in 8269 ms
webpack 5.106.0 compiled successfully in 9120 ms

$ yarn lint
# (no output; exit 0 after a single prettier --fix on
#   apps/inventory-microservice/src/app/app.module.ts to wrap a
#   long config import)

$ yarn test:unit
PASS apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/spec/product-stock-common-get.service.spec.ts
PASS apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/spec/product-stock-common-add.service.spec.ts
PASS apps/retail-microservice/src/app/api/order/domain/spec/order-confirm.domain.spec.ts
PASS apps/inventory-microservice/src/app/common/modules/product-stock-common/spec/product-stock-common.service.spec.ts
PASS apps/inventory-microservice/src/app/api/product-stock/providers/spec/product-stock-order-confirm.service.spec.ts
PASS apps/inventory-microservice/src/app/api/product-stock/providers/spec/product-stock-get.service.spec.ts
PASS apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/spec/product-stock-common-cache.service.spec.ts

Test Suites: 7 passed, 7 total
Tests:       59 passed, 59 total
```

All four exit gates pass. Coverage is unchanged from the task-02
exit gate (no behavioral changes; the only edits to `apps/*/src/`
are import-path rewrites and the `app.module.ts` swap from
`new TypeormModuleConfig(entities)` to `DatabaseModule.forRoot(entities)`).

### Working-tree shape

`git diff --stat HEAD` reports **73 files changed, 127 insertions,
287 deletions** total. The deletions come from removing the moved
files under `libs/{common/enums,common/interfaces,inventory,retail}`;
they re-appear with the same content under `libs/contracts/`. The
unstaged status:

- **38 modified files** under `apps/` — every edit is a single
  import-path rewrite of 1–6 lines. Spot-check confirmed for
  representative spec, controller, service, and entity files.
- **3 modified configs** at root: `tsconfig.json`,
  `jest.unit.config.js`, `jest.e2e.config.js`. Each adds two new
  path-alias entries (`contracts`, `database`) without removing the
  existing four.
- **2 modified docs**: `README.md`, `CLAUDE.md`.
- **`libs/common/`** has 4 modified files (`index.ts`,
  `config/microservice-client-configuration.ts`, the two
  `modules/*.module.ts`) and 7 deleted files (`enums/*`,
  `interfaces/*`). The four new utility scaffolds (`result.ts`,
  `exceptions/`, `pagination/`, `types/`) appear as untracked.
- **`libs/inventory/`** and **`libs/retail/`**: only `index.ts`
  remains (now a one-line shim re-export); 16 source files are
  marked deleted, all relocated under `libs/contracts/`.
- **`libs/contracts/`** and **`libs/database/`** appear as untracked
  directories.
- **`docs/adr/005-…`** and **`docs/architecture-migration-plan/tasks/_carryover-03.md`**
  appear as untracked.

No `apps/*/src/` file was modified beyond import-path rewrites or
the two `app.module.ts` swaps to `DatabaseModule.forRoot()` that
step 7 explicitly required.

### Final import distribution under apps

```
17  } from '@retail-inventory-system/contracts';   (multi-line closers)
 8  import { ProductStockGetResponseDto } from '@retail-inventory-system/contracts';
 5  import { AppNameEnum } from '@retail-inventory-system/contracts';
 4  import { LoggerModuleConfig } from '@retail-inventory-system/config';
 3  import { OrderStatusEnum } from '@retail-inventory-system/contracts';
 3  import { OrderProductStatusEnum } from '@retail-inventory-system/contracts';
 3  import { MicroserviceQueueEnum, AppNameEnum } from '@retail-inventory-system/contracts';
 3  import { ICorrelationPayload } from '@retail-inventory-system/common';
 3  import { configModuleConfig, LoggerModuleConfig } from '@retail-inventory-system/config';
 2  import { MicroserviceMessagePatternEnum } from '@retail-inventory-system/contracts';
 2  import { MicroserviceClientInventoryModule } from '@retail-inventory-system/common';
 2  import { IOrderProductConfirm, OrderProductStatusEnum } from '@retail-inventory-system/contracts';
 2  import { DatabaseModule } from '@retail-inventory-system/database';
 2  import { CorrelationId } from '@retail-inventory-system/common';
 1  import { MicroserviceClientRetailModule } from '@retail-inventory-system/common';
 1  import { IProductStockOrderConfirmPayload } from '@retail-inventory-system/contracts';
 1  import { IOrderCreatePayload } from '@retail-inventory-system/contracts';
 1  import { IOrderConfirm, IOrderConfirmPayload } from '@retail-inventory-system/contracts';
 1  import { CorrelationMiddleware } from '@retail-inventory-system/common';
 1  import { CacheHelper } from '@retail-inventory-system/common';
```

Zero imports remain pointing at `@retail-inventory-system/inventory`
or `@retail-inventory-system/retail`. The shims at those paths are
present (defence-in-depth) but no app currently uses them.

### Updated import sites under apps (full list)

The 38 modified files under `apps/`:

- **api-gateway**: `main.ts`, `app/app.module.ts`,
  `app/api/order/order.controller.ts`,
  `app/api/order/pipes/order-confirm.pipe.ts`,
  `app/api/order/providers/order-confirm.service.ts`,
  `app/api/order/providers/order-create.service.ts`,
  `app/api/product/product.controller.ts`,
  `app/api/product/providers/product-stock-get.service.ts`.
- **inventory-microservice**: `main.ts`, `app/app.module.ts`,
  `app/api/product-stock/product-stock.controller.ts`,
  `app/api/product-stock/providers/product-stock-get.service.ts`,
  `app/api/product-stock/providers/product-stock-order-confirm.service.ts`,
  `app/api/product-stock/providers/spec/product-stock-get.service.spec.ts`,
  `app/api/product-stock/providers/spec/product-stock-order-confirm.service.spec.ts`,
  `app/common/modules/product-stock-common/product-stock-common.service.ts`,
  `app/common/modules/product-stock-common/spec/product-stock-common.service.spec.ts`,
  `app/common/modules/product-stock-common/interfaces/product-stock-common-cache.interface.ts`,
  `app/common/modules/product-stock-common/providers/product-stock-common-cache.service.ts`,
  `app/common/modules/product-stock-common/providers/product-stock-common-get.service.ts`,
  `app/common/modules/product-stock-common/providers/spec/product-stock-common-cache.service.spec.ts`.
- **notification-microservice**: `main.ts`, `app/app.module.ts`.
- **retail-microservice**: `main.ts`, `app/app.module.ts`,
  `app/api/order/order.controller.ts`,
  `app/api/order/pipes/order-confirm.pipe.ts`,
  `app/api/order/pipes/order-create.pipe.ts`,
  `app/api/order/providers/order-confirm.service.ts`,
  `app/api/order/providers/order-create.service.ts`,
  `app/api/order/domain/order-confirm.domain.ts`,
  `app/api/order/domain/spec/order-confirm.domain.spec.ts`,
  `app/common/entities/order.entity.ts`,
  `app/common/entities/order-product.entity.ts`,
  `app/common/entities/order-status.entity.ts`,
  `app/common/entities/order-product-status.entity.ts`.

## 6. Suggested adjustments to task-04

Task-04 lands the integration libs (`messaging`, `cache`,
`observability`, `ddd`). Concrete recommendations informed by what
this task left in place:

1. **`libs/messaging`** is the new home for everything still under
   `libs/common/{config/microservice-client-configuration.ts,modules/}`:
   `MicroserviceClientConfiguration`,
   `MicroserviceClientInventoryModule`,
   `MicroserviceClientRetailModule`. Move them as-is in task-04;
   the routing-key migration to dotted `<service>.<aggregate>.<event>`
   should be a second step within task-04 once `libs/messaging`
   exists, **not** part of the move itself, so the diff stays
   reviewable. The `microservices/` subfolder in `libs/contracts`
   is the right place to land the dotted routing-key constants.

2. **`libs/cache`** is the new home for `libs/common/cache/cache.helper.ts`
   and for `libs/config/cache-module.config.ts` (`cacheModuleConfig`).
   The 17 audit items from `docs/audits/audit-2026-05-08.md` (cache
   stampede, schema-version segment, multi-tenant prefix) are still
   open and should be revisited as part of the move — the `CacheHelper`
   already carries inline `AUDIT-2026-05-08` markers pointing at
   each open issue, so task-04 has a clear punch list.

3. **`libs/observability`** is the new home for `libs/common/correlation/`
   (constants, decorator, middleware, types) and for
   `libs/config/logger-module.config.ts` (`LoggerModuleConfig`). The
   trace-id enrichment that ADR-004 / recommendation Section 2 calls
   out is the OTel work scheduled for task-10; task-04 should land
   the structural relocation only and leave the OTel wiring for
   task-10.

4. **`libs/ddd`** is new — `aggregate-root.base.ts`,
   `entity.base.ts`, `value-object.base.ts`, `domain-event.base.ts`,
   `repository.port.ts`. Nothing in this task created scaffolds for
   any of these; task-04 builds them fresh.

5. **Shim retirement.** Task-04 should *not* remove the shims left
   by this task in `libs/{common,inventory,retail}/index.ts` or
   `libs/config/typeorm-module.config.ts`. The shims are scheduled
   for deletion in task-14 once every consumer has been confirmed
   migrated; removing them mid-flight in task-04 risks breaking the
   per-service align tasks (task-08, task-09) that haven't been
   touched yet.

6. **`tsconfig.json` paths.** Task-04 will add four more aliases
   (`messaging`, `cache`, `observability`, `ddd`) to the same three
   files updated here (`tsconfig.json`, `jest.unit.config.js`,
   `jest.e2e.config.js`). Following the same pattern this task
   used — alphabetical order within the `paths` block — keeps the
   diff predictable.

7. **`libs/contracts/retail/interfaces/order-confirm.interface.ts`**
   and **`libs/contracts/inventory/product-stock/product-stock-get/product-stock-get.types.ts`**
   currently import `ICorrelationPayload` from
   `@retail-inventory-system/common`. After task-04 moves
   correlation types to `libs/observability`, those two import
   paths need updating in the same task that does the relocation.
   They are the only consumers of `ICorrelationPayload` inside
   `libs/contracts/`, so the update is a two-line change.

8. **No `nest-cli.json` divergence.** This task did not register
   `contracts` or `database` under `nest-cli.json` `projects`. If
   task-04 wants to standardize all six libs as proper Nest
   libraries (with `src/` and per-lib `tsconfig.lib.json`), it
   should do all six at once and update both `nest-cli.json` and
   the path aliases in the same task. Otherwise keep the current
   flat layout.

## 7. Anything unexpected

- **`prettier/prettier` lint failure on the rewritten
  `inventory-microservice/src/app/app.module.ts`.** The first pass
  fit `cacheModuleConfig, configModuleConfig, LoggerModuleConfig`
  on a single import line, which exceeds the 100-char prettier
  limit. Fixed by wrapping the import to one symbol per line.
  Calling out for task-04: when relocating `cacheModuleConfig` to
  `libs/cache` you'll touch the same import block again — expect
  prettier to want the wrap re-flowed when the symbol drops out.
- **`yarn build` ran clean on first attempt.** The path-alias
  additions, the `DatabaseModule.forRoot()` swap, and the
  `libs/inventory`/`libs/retail` shimming all took effect without
  any TS errors — a small confirmation that the shims correctly
  cover the moved-symbols set.
- **No spec files needed updating beyond import paths.** The seven
  unit specs that exist today (inventory product-stock + retail
  order-confirm domain) all cleanly reuse the relocated DTOs and
  enums via the new contracts path. Task-08 / task-09 will likely
  add more specs as they relocate services into the per-module
  hexagonal layout.
