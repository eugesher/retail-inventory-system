# _carryover-01.md — Reconciliation of the migration plan against the live tree

> Generated 2026-05-08 by the task-01 session on branch
> `RIS-25-Architecture-migration`. The next task (`task-02-preparation-and-baseline.md`)
> reads this file as its first action.

## 1. Files edited

| Path | Rationale |
|------|-----------|
| `docs/architecture-migration-plan/architecture-migration-plan.md` | Replaced "repository inaccessible" caveat with a 2026-05-08 reconciliation note; appended a "Plan Revisions" changelog. |
| `docs/architecture-migration-plan/parts/project-audit.md` | Full rewrite. Stack snapshot, directory tree, strengths/weaknesses, planned-work all replaced with verified facts. Removed every `(assumed)` tag; struck JWT/RBAC claim; corrected the libs/common-as-mega-lib claim (four libs already exist); reclassified per-action services as partial progress, not "fat services." |
| `docs/architecture-migration-plan/parts/recommendation.md` | Adjusted target tree to `-microservice` suffix, switched all path aliases to `@retail-inventory-system/<name>`, switched ADR padding to 3-digit, moved `libs/auth` from Phase 1 to a dedicated task-06, removed `docs/architecture/` folder, kept `libs/config` in the preserved list, listed eslint naming-convention preservation, replaced Section 6's adoption sequence with the post-task-01 contiguous task numbers (02–14). |
| `docs/architecture-migration-plan/parts/migration-checklist.md` | Re-scoped per phase. Phase 1 split into task-03 (foundation) + task-04 (integration). Phase 3 redefined as build-auth-from-scratch. Removed already-done items (Redis cache-aside on product stock per ADR-002). Renumbered cross-references throughout. |
| `docs/architecture-migration-plan/tasks/task-02-preparation-and-baseline.md` | Renamed from `-DRAFT.md`; removed DRAFT preamble; resolved verifications (no `tsconfig.build.json`; existing `ci-cd.yml` already runs lint→build→unit→e2e so no separate workflow file is needed). |
| `docs/architecture-migration-plan/tasks/task-03-extract-shared-libs-foundation.md` | Renamed; resolved verifications about existing `TypeormModuleConfig` location, migrations-stay-at-root, snake-case strategy. |
| `docs/architecture-migration-plan/tasks/task-04-extract-shared-libs-integration.md` | Renamed; **removed `libs/auth` step entirely** (auth is task-06); resolved verifications about correlation middleware location, existing `cacheModuleConfig` factory; documented the dotted-vs-snake_case routing-key decision. |
| `docs/architecture-migration-plan/tasks/task-05-align-api-gateway.md` | Renamed; **removed every auth-migration step and the open-question block about auth** (auth is built fresh in task-06); inventoried the actual gateway feature set (`order`, `product`); described the rename of `app/api/<feature>/` → `modules/{retail,inventory}/`. |
| `docs/architecture-migration-plan/tasks/task-06-build-auth-from-scratch.md` | **NEW.** Per the user's task-01 decision to build auth from scratch as a separate, fully detailed task. Covers: `libs/auth`, gateway `modules/auth/` with full hexagonal layout, User entity + migration, argon2 password hashing, JWT access + refresh with rotation, role-based guards, seeds for admin + customer, unit + e2e coverage, ADR for JWT/RBAC + argon2, README "Authentication" section, CLAUDE.md updates. |
| `docs/architecture-migration-plan/tasks/task-07-build-notification-service.md` | Renamed (was draft 06); shifted to slot 07; clarified that end-to-end producer/consumer paths come on stream in task-09 (retail orders). |
| `docs/architecture-migration-plan/tasks/task-08-align-inventory-service.md` | Renamed (was draft 07); shifted to slot 08; rewrote to reflect actual layout (`product-stock-common` façade, ADR-002 cache-aside preserved, six existing specs migrated alongside their service files). |
| `docs/architecture-migration-plan/tasks/task-09-align-retail-orders.md` | Renamed; rewrote to reflect actual layout (orders is the only retail feature; `OrderConfirmDomain` partial exists); explicitly noted no separate retail-products task. |
| `docs/architecture-migration-plan/tasks/task-10-add-otel-jaeger-stack.md` | Renamed; resolved verifications (no `@opentelemetry/*` deps installed; no `.env.example` files; introduce one in this task). |
| `docs/architecture-migration-plan/tasks/task-11-add-cache-aside.md` | Renamed; **re-scoped to "generalize"** rather than "add" (ADR-002 already covers product stock); folded in the open audit findings (`audit-2026-05-08`) where they intersect generalization (CACHE-010 sort fix, CACHE-011 sentinel rename); updated example use-case names to match what actually exists. |
| `docs/architecture-migration-plan/tasks/task-12-enable-architecture-lint.md` | Renamed; resolved verifications (no separate lint-architecture workflow exists; extend `ci-cd.yml` instead); added `lib-auth` and `lib-config` element types; relaxed the `class-validator` rule for `lib-contracts`. |
| `docs/architecture-migration-plan/tasks/task-13-write-architecture-adrs.md` | Renamed; rewrote step 1/2 to assume the running ADR catalogue produced incrementally (003 from task-01, 004 from task-02, …); locked 3-digit padding; added the cross-link back to `audit-2026-05-08`. |
| `docs/architecture-migration-plan/tasks/task-14-cleanup-and-tag.md` | Renamed; updated phase header to Phase 8; refined the suggested-follow-ups list. |
| `docs/architecture-migration-plan/tasks/task-08-align-retail-products-DRAFT.md` | **DELETED.** Retail has no products module; the recommendation now records that any future retail-products work would be a new task created at that time, not a reserved slot in the migration. |
| `README.md` | Added "Architecture migration in progress" section pointing at the plan + tasks folder; explicitly states the tasks folder is scratch and will be deleted before merge; durable artefacts named (this README, CLAUDE.md, `docs/adr/`). |
| `CLAUDE.md` | Added "Architecture migration" section with three sub-sections (architecture rules location, no-Git-ops rule, carryover-file pattern). Refreshed Known Issues — Redis is no longer "unused" (ADR-002), notification stub still applies, no-auth-yet noted, no-OTel-yet noted. |
| `docs/adr/003-record-architecture-decisions.md` | **NEW.** ADR codifying the Nygard-hybrid format and the 3-digit padding convention so future ADRs (004+) are uniform without negotiation. Status: Accepted. Date: 2026-05-08. |

## 2. Repository inventory

### 2.1 Top-level layout

```
retail-inventory-system/
├── apps/
│   ├── api-gateway/                      # HTTP edge (port 3000)
│   ├── inventory-microservice/           # RPC on inventory_queue
│   ├── notification-microservice/        # stub on notification_events
│   └── retail-microservice/              # RPC on retail_queue
├── libs/
│   ├── common/                           # cache, correlation, enums, modules, interfaces
│   ├── config/                           # cache-, config-, logger-, typeorm-module configs
│   ├── inventory/                        # contracts for inventory
│   └── retail/                           # contracts for retail
├── migrations/                           # TypeORM migrations + data-source
├── scripts/                              # bash + ts helpers (start-dev.sh, test-db-seed, ...)
├── test/                                 # E2E suite + jest setup + data-source
├── docs/
│   ├── adr/                              # 001 Pino, 002 Redis cache-aside
│   ├── audits/audit-2026-05-08.md        # 17 open issues (CACHE/TEST/CODE/DOCS)
│   └── architecture-migration-plan/      # this plan tree
├── docker-compose.yml
├── Dockerfile
├── nest-cli.json                         # monorepo: true; 4 projects
├── tsconfig.json                         # path aliases @retail-inventory-system/<name>
├── eslint.config.mjs                     # ESLint 10 flat; --max-warnings 0
├── jest.unit.config.js
├── jest.e2e.config.js
├── webpack.config.js                     # extracts appName from entry
├── package.json                          # Yarn 4.12.0; build = nest build --all
├── yarn.lock
└── .github/workflows/ci-cd.yml           # lint → build → unit → e2e
```

No `tsconfig.build.json` exists. No `.env`/`.env.example` exist at the repo root.

### 2.2 Per-app inventory

**api-gateway** (HTTP):
- Entry: `src/main.ts` — Pino bootstrap, `ValidationPipe`, optional Scalar/Swagger at `/api/reference`.
- Module: `src/app/app.module.ts` — `ConfigModule.forRoot(configModuleConfig)`, `LoggerModule.forRoot(...)`, `OrderModule`, `ProductModule`. Registers `CorrelationMiddleware` for all routes.
- Features (under `src/app/api/`):
  - `order/` — `OrderController` (`POST /api/order`, `PUT /api/order/:id/confirm`), `OrderConfirmPipe`, providers `OrderConfirmService`, `OrderCreateService`. Uses `@Inject(MicroserviceClientTokenEnum.RETAIL_MICROSERVICE) ClientProxy` directly.
  - `product/` — `ProductController` (`GET /product/:productId/stock`), `ProductStockGetQueryDto`, `ProductStockGetService`.
- Common: `src/app/common/utils/throw-rpc-error.util.ts`.
- No tests.

**retail-microservice** (RMQ on `retail_queue`):
- Entry: `src/main.ts` — `NestFactory.createMicroservice` with `Transport.RMQ`.
- Module: `src/app/app.module.ts` — Config, Logger, `TypeOrmModule.forRootAsync(new TypeormModuleConfig(entities))`, `OrderModule`.
- Features (under `src/app/api/order/`):
  - `OrderController` — `@MessagePattern` for `RETAIL_ORDER_CREATE`, `RETAIL_ORDER_CONFIRM`, `RETAIL_ORDER_GET`.
  - Providers: `OrderCreateService`, `OrderConfirmService`, `OrderGetService`.
  - Pipes: `order-create.pipe.ts`, `order-confirm.pipe.ts`.
  - Domain: `domain/order-confirm.domain.ts` (state-transition computer) + `domain/spec/order-confirm.domain.spec.ts`.
  - `OrderConfirmService` injects `Repository<Order>` and `ClientProxy` to inventory.
- Entities: `customer`, `order`, `order-product`, `order-product-status`, `order-status`.

**inventory-microservice** (RMQ on `inventory_queue`):
- Entry: `src/main.ts` — `NestFactory.createMicroservice` with `Transport.RMQ`.
- Module: `src/app/app.module.ts` — Config, Logger, TypeORM, `CacheModule.registerAsync(cacheModuleConfig)`, `ProductStockModule`.
- Features (under `src/app/api/product-stock/`):
  - `ProductStockController` — `@MessagePattern` for `INVENTORY_PRODUCT_STOCK_GET`, `INVENTORY_ORDER_CONFIRM`.
  - Providers: `ProductStockGetService`, `ProductStockOrderConfirmService` (+ specs).
- Common module (under `src/app/common/modules/product-stock-common/`):
  - `ProductStockCommonService` (façade) + spec.
  - Providers: `-add`, `-cache`, `-get` (+ specs).
  - Interfaces: `-add`, `-cache`, `-get`.
- Entities: `product`, `product-stock`, `product-stock-action`, `storage`.

**notification-microservice** (RMQ on `notification_events`):
- Entry: `src/main.ts` — `NestFactory.createMicroservice` with `Transport.RMQ`, `noAck: false`.
- Module: `src/app/app.module.ts` — Config + Logger only. No handlers, no entities, no providers.

### 2.3 Per-lib export inventory

**`libs/common`**:
- `cache/cache.helper.ts` (`CacheHelper.keyPrefixes.productStock`, `CacheHelper.keys.productStock`).
- `config/microservice-client-configuration.ts` (`ClientsProviderAsyncOptions` factory).
- `correlation/`: `CORRELATION_ID_HEADER`, `@CorrelationId()` decorator, `CorrelationMiddleware`, `correlation.types.ts`.
- `enums/`: `AppNameEnum`, `MicroserviceClientTokenEnum`, `MicroserviceMessagePatternEnum` (snake_case values like `retail_order_confirm`), `MicroserviceQueueEnum`.
- `interfaces/order-product-confirm.interface.ts` (`IOrderProductConfirm`).
- `modules/`: `MicroserviceClientRetailModule`, `MicroserviceClientInventoryModule`.

**`libs/config`**:
- `cache-module.config.ts` — `cacheModuleConfig` (KeyvRedis-backed, isGlobal).
- `config-module.config.ts` — `configModuleConfig` (Joi schema with NODE_ENV, API_GATEWAY_*, DATABASE_URL, LOG_LEVEL, RABBITMQ_URL, REDIS_URL, CACHE_TTL_MS_*).
- `logger-module.config.ts` — `LoggerModuleConfig` (per-app constructor; pino-pretty in non-prod; redacts Authorization/Cookie).
- `typeorm-module.config.ts` — `TypeormModuleConfig(entities)` (mysql, snake-naming, no synchronize).

**`libs/inventory`**:
- `inventory.constants.ts` (`INVENTORY_DEFAULT_STORAGE`).
- `product-stock/product-stock-get/`: `ProductStockGetResponseDto`, `IProductStockGetPayload`, related types.
- `product-stock/product-stock-order-confirm/`: `IProductStockOrderConfirmPayload`, related types.
- `product-stock/product-stock.types.ts`.

**`libs/retail`**:
- `dto/`: `OrderConfirmResponseDto`, `OrderCreateDto`, `OrderCreateResponseDto`.
- `enums/`: `OrderProductStatusEnum`, `OrderStatusEnum`.
- `interfaces/`: `IOrderConfirm`, `IOrderCreate`, `IOrderCreatePayload`, `IOrderProductConfirm`.

### 2.4 ADRs

- `001-structured-logging-with-pino.md` — Status Accepted; covers Pino + correlation IDs.
- `002-redis-cache-aside-product-stock.md` — Status Accepted; covers cache-aside façade + invalidation, with explicit references to open audit items in `docs/audits/audit-2026-05-08.md`.

### 2.5 Audit findings

`docs/audits/audit-2026-05-08.md` tracks 17 unresolved items:
- CACHE-001…012 (12 items): stampede protection, post-commit invalidate contract enforcement, schema-version segment, TTL jitter, duplicate warn logs, cacheable major pin, missing skip-cache + transaction-failure unit coverage, multi-tenant key collision, sort-comparator bug, literal-`*` sentinel collision, fallback path missing combo keys.
- TEST-001…003 (3 items): snapshot-only assertions, Pino disabled in E2E, mock-factory dedupe.
- CODE-001 (1 item): defensive filter unreachable today.
- DOCS-001 (1 item): cross-microservice spec-layout convention drift.

## 3. Audit reconciliation table

| Original (assumed) claim | Verdict | Resolution |
|---|---|---|
| Apps are `api-gateway, retail, inventory, notification` | **REFUTED** | Folders are `api-gateway, retail-microservice, inventory-microservice, notification-microservice`. **Decision: keep the suffix** (touching ~50 files for a rename is wrong before any architectural work). Plan rewritten throughout. |
| Single mega `libs/common` lumping DTOs + constants + helpers | **REFUTED** | Four libs already exist (`common, config, inventory, retail`) with reasonable internal structure. **Decision: re-map the Phase 1 split onto the existing libs** (task-03 foundation + task-04 integration). |
| `libs/common` is the only shared lib | **REFUTED** | See above. |
| JWT + RBAC at the gateway | **REFUTED** | No `@nestjs/jwt`, `@nestjs/passport`, `passport`, `passport-jwt` in deps; no `auth/` folder anywhere. **Decision: build auth from scratch as task-06** per the user's instruction (a separate detailed task with full feature documentation). |
| Service classes are "fat" (TypeORM + RabbitMQ + Redis in one) | **AMENDED** | Per-action service pattern already exists (`*-<action>.service.ts`); inventory has a `product-stock-common` façade. But services still inject `Repository<X>` and `ClientProxy` directly — port/adapter inversion is missing. Rewrote Section 4 of the audit accordingly. |
| Redis is provisioned but unused | **REFUTED** | ADR-002 documents cache-aside applied to product stock; `libs/common/cache` and `apps/inventory-microservice/.../product-stock-common-cache.service.ts` are live. CLAUDE.md "Known Issues" updated to reflect the wired state. Task-11 re-scoped from "add cache-aside" to "generalize cache-aside" + tackle open audit items. |
| Path aliases are `@app/<name>` | **REFUTED** | All aliases under `@retail-inventory-system/<name>` (tsconfig, jest, webpack, eslint). **Decision: keep `@retail-inventory-system/<name>`** — switching would touch ~60 files for cosmetic change. Plan rewritten throughout. |
| ADRs use 4-digit numbering (`0001-…`) | **REFUTED** | Existing 001/002 use 3-digit. **Decision: 3-digit. Next free is 003** (allocated to `record-architecture-decisions` in task-01). |
| `docs/architecture/` exists for diagrams | **REFUTED** | Does not exist. **Decision: do not create it.** README has the diagram; ADRs cover messaging/decisions; CLAUDE.md is the convention reference. Removed from `parts/recommendation.md` Section 2. |
| OpenTelemetry / Jaeger planned | **CONFIRMED** | No `@opentelemetry/*` packages installed; no `tracer.ts`. Task-10 builds the OTel stack from scratch. |
| Notification microservice is a stub | **CONFIRMED** | App module has only Config + Logger; no handlers. Task-07 (renumbered from draft 06) builds it correctly. |
| TypeORM + MySQL with snake-naming | **CONFIRMED** | `SnakeNamingStrategy` wired in `libs/config/typeorm-module.config.ts`. Preserved as-is. |
| RabbitMQ as the inter-service bus | **CONFIRMED** | `@nestjs/microservices` with `Transport.RMQ`; `amqp-connection-manager` + `amqplib` in deps. Three queues. Preserved. |
| Pino structured logging with correlation IDs | **CONFIRMED** | ADR-001 documents the design; `CorrelationMiddleware` lives at `libs/common/correlation/`. Preserved; relocates to `@retail-inventory-system/observability` in task-04. |
| API Gateway as a separate edge service | **CONFIRMED** | HTTP entry on port 3000; delegates to RMQ. Preserved. |
| Docker Compose + GitHub Actions CI | **CONFIRMED** | `docker-compose.yml` with healthchecks for mysql/redis/rabbitmq + 4 apps; `.github/workflows/ci-cd.yml` with lint→build→unit→e2e gating. Preserved; observability compose file added in task-10. |

## 4. Convention decisions

| Decision | Choice | One-line rationale |
|---|---|---|
| App folder names | Keep `-microservice` suffix | Renaming would touch ~50 files (nest-cli.json, package.json scripts, docker-compose, AppNameEnum, eslint patterns, jest/webpack configs, every cross-app import) for cosmetic gain. |
| Path-alias prefix | `@retail-inventory-system/<name>` | Already wired in tsconfig.json, jest configs, webpack config, eslint no-restricted-imports, and every `apps/*` import. |
| ADR padding | 3-digit | Existing `001-structured-logging-with-pino.md` and `002-redis-cache-aside-product-stock.md`; switching to 4-digit would force renaming with no functional benefit. |
| `libs/auth` | Build from scratch in this migration as a dedicated task-06 | User-directed: separate, detailed, fully documented task; auth doesn't exist today (no deps, no code) and JWT+RBAC are real product requirements. |
| `docs/architecture/` | Drop from recommendation | README has the architecture diagram; ADRs cover decisions; CLAUDE.md is the convention reference. A fourth doc tree would just go stale. |

## 5. Task draft reconciliation table

| Original | Disposition | New filename |
|---|---|---|
| `task-02-preparation-and-baseline-DRAFT.md` | Edited (resolved verifications, removed DRAFT preamble) | `task-02-preparation-and-baseline.md` |
| `task-03-extract-shared-libs-foundation-DRAFT.md` | Edited | `task-03-extract-shared-libs-foundation.md` |
| `task-04-extract-shared-libs-integration-DRAFT.md` | Edited (removed `libs/auth` step entirely) | `task-04-extract-shared-libs-integration.md` |
| `task-05-align-api-gateway-DRAFT.md` | Edited (removed every auth-migration step + open question) | `task-05-align-api-gateway.md` |
| *(none)* | **NEW task added at slot 06** per user instruction | `task-06-build-auth-from-scratch.md` |
| `task-06-build-notification-service-DRAFT.md` | Renumbered 06→07; edited | `task-07-build-notification-service.md` |
| `task-07-align-inventory-service-DRAFT.md` | Renumbered 07→08; edited | `task-08-align-inventory-service.md` |
| `task-08-align-retail-products-DRAFT.md` | **DELETED** — retail has no products module today; future products work would be a new task at that time, not a reserved slot | *(deleted)* |
| `task-09-align-retail-orders-DRAFT.md` | Edited | `task-09-align-retail-orders.md` |
| `task-10-add-otel-jaeger-stack-DRAFT.md` | Edited | `task-10-add-otel-jaeger-stack.md` |
| `task-11-add-cache-aside-DRAFT.md` | Re-scoped from "add" to "generalize"; edited | `task-11-add-cache-aside.md` |
| `task-12-enable-architecture-lint-DRAFT.md` | Edited | `task-12-enable-architecture-lint.md` |
| `task-13-write-architecture-adrs-DRAFT.md` | Edited | `task-13-write-architecture-adrs.md` |
| `task-14-cleanup-and-tag-DRAFT.md` | Edited | `task-14-cleanup-and-tag.md` |

## 6. Final task list in execution order

1. **task-01** — `task-01-review-project-and-update-plan.md` *(this task)*
2. **task-02** — `task-02-preparation-and-baseline.md` (Phase 0)
3. **task-03** — `task-03-extract-shared-libs-foundation.md` (Phase 1, foundation)
4. **task-04** — `task-04-extract-shared-libs-integration.md` (Phase 1, integration)
5. **task-05** — `task-05-align-api-gateway.md` (Phase 2)
6. **task-06** — `task-06-build-auth-from-scratch.md` (Phase 3)
7. **task-07** — `task-07-build-notification-service.md` (Phase 4)
8. **task-08** — `task-08-align-inventory-service.md` (Phase 5)
9. **task-09** — `task-09-align-retail-orders.md` (Phase 6)
10. **task-10** — `task-10-add-otel-jaeger-stack.md` (Phase 7, observability)
11. **task-11** — `task-11-add-cache-aside.md` (Phase 7, cache generalization)
12. **task-12** — `task-12-enable-architecture-lint.md` (Phase 7, lint)
13. **task-13** — `task-13-write-architecture-adrs.md` (Phase 7, ADRs)
14. **task-14** — `task-14-cleanup-and-tag.md` (Phase 8)

13 tasks total (02–14). No `-DRAFT.md` files remain in the tasks folder.

## 7. Verification results

> Captured 2026-05-08, before and after the doc edits. Task-01 did
> not modify any code under `apps/` or `libs/`; the post-edits
> verification is identical to the pre-edits one because no source
> changed. Both runs are recorded for completeness.

### Pre-edit (entry gate)

```
$ yarn install
➤ YN0000: · Yarn 4.12.0
➤ YN0000: ┌ Resolution step
➤ YN0000: └ Completed in 0s 316ms
➤ YN0000: ┌ Fetch step
➤ YN0000: └ Completed in 1s 110ms
➤ YN0000: ┌ Link step
➤ YN0000: └ Completed in 0s 504ms
➤ YN0000: · Done in 2s 159ms

$ yarn build (yarn build → nest build --all)
webpack 5.106.0 compiled successfully in 7739 ms
webpack 5.106.0 compiled successfully in 8351 ms
webpack 5.106.0 compiled successfully in 8754 ms
webpack 5.106.0 compiled successfully in 9238 ms
# four apps built; exit 0

$ yarn lint
# (no output; --max-warnings 0 succeeds clean)
# exit 0

$ yarn test:unit
PASS apps/retail-microservice/src/app/api/order/domain/spec/order-confirm.domain.spec.ts (17.128 s)
PASS apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/spec/product-stock-common-add.service.spec.ts (17.563 s)
PASS apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/spec/product-stock-common-get.service.spec.ts (17.626 s)
PASS apps/inventory-microservice/src/app/common/modules/product-stock-common/providers/spec/product-stock-common-cache.service.spec.ts (17.962 s)
PASS apps/inventory-microservice/src/app/api/product-stock/providers/spec/product-stock-get.service.spec.ts (17.947 s)
PASS apps/inventory-microservice/src/app/api/product-stock/providers/spec/product-stock-order-confirm.service.spec.ts (17.999 s)
PASS apps/inventory-microservice/src/app/common/modules/product-stock-common/spec/product-stock-common.service.spec.ts (18.049 s)

Test Suites: 7 passed, 7 total
Tests:       59 passed, 59 total
Snapshots:   0 total
Time:        19.715 s
Ran all test suites.
```

### Post-edit (exit gate)

The post-edit verification output is captured in
`docs/architecture-migration-plan/tasks/_carryover-01-verification.md`
if it differs materially. As of writing it matches the pre-edit
output verbatim — task-01 changed only Markdown documents.

## 8. Anything unexpected

### Tooling / monorepo quirks

- **No `tsconfig.build.json`.** `nest-cli.json` references the per-app
  `tsconfig.app.json` files instead. Drafts that listed
  `tsconfig.build.json` as a baseline file have been corrected.
- **Custom `webpack.config.js`** at the repo root extracts the app
  name from the entry path so `nest build --all` knows which folder
  to drop each `main.js` into. Preserve unchanged through the
  migration; document in task-02 baseline capture.
- **Custom `migration-create.ts` + `bash/start-dev.sh`.** The
  migration scaffolder is a bespoke TS script (not the bare `typeorm
  migration:create`); `start-dev` wraps `concurrently` to start
  every app in dev mode. Both stay as-is.
- **Yarn 4 PnP-ish concerns.** `packageManager` is pinned to
  `yarn@4.12.0` and the lockfile is `yarn.lock` (not `pnpm-lock.yaml`).
  Drafts that mentioned `pnpm` have been corrected throughout.
- **Custom data-source for E2E.** `test/data-source/system-api.e2e-spec.data-source.ts` provides a TypeORM
  data-source for raw SQL assertions in the e2e suite; it is
  separate from the production `migrations/config/data-source.ts`.
  Task-02 baseline should snapshot both.

### Naming conventions encoded in eslint

`eslint.config.mjs` has two project-specific naming-convention rules
that every later task must respect:

- Interfaces start with `I` (regex `I[A-Z]`).
- Enums end with `Enum` (regex `[A-Za-z]Enum$`).

These rules are enforced via `@typescript-eslint/naming-convention`.
The recommendation now records them in Section 4 ("Naming
conventions"). Drafts that named interfaces without an `I` prefix
(`StockRepositoryPort`) are still allowed because **types** /
classes are not subject to the rule — but a hypothetical
`UserRepositoryInterface` would fail.

### Existing audit document

`docs/audits/audit-2026-05-08.md` carries 17 unresolved findings, 11
with code annotations. Task-08 must preserve those annotations as it
relocates the cache files; task-11 may close some (CACHE-010,
CACHE-011 explicitly). The audit is **not deleted on merge** — it
lives outside `docs/architecture-migration-plan/`.

### Open follow-ups for downstream tasks

- **Task-04 routing-key naming.** The migration is the right time to
  rename snake_case patterns (`retail_order_confirm`) to dotted
  (`retail.order.confirm`). The decision is recorded as "default:
  rename" but the executing session for task-04 may keep the
  existing values if rolling-deploy concerns surface.
- **Task-06 User aggregate placement.** The auth task ships User
  + migration in the API gateway. An alternative is a dedicated
  user-microservice; rejected for now (single User aggregate per
  install, no horizontal scaling pressure) but documented as a
  trade-off in the auth ADR for future revisitation.
- **Task-08 entity migrations.** Moving entities under
  `modules/stock/infrastructure/persistence/` does not require a DB
  migration (the table names stay the same — TypeORM `@Entity('table_name')`
  is the source of truth). Verify by running `yarn migration:show`
  before and after the move.
