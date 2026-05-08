# Project Audit — Retail Inventory System

> Verified 2026-05-08 against the live tree on branch
> `RIS-25-Architecture-migration`. Earlier `(assumed)` tags from the
> reconstruction pass have been resolved; where reality differed from the
> brief, the section was rewritten rather than annotated. See
> `docs/architecture-migration-plan/tasks/_carryover-01.md` for the full
> reconciliation table.

## 1. Stack snapshot

| Concern                 | Tool / pattern                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------- |
| Framework               | NestJS 11 (monorepo workspace, `nest-cli.json` with `monorepo: true`)                           |
| Build                   | Webpack via `@nestjs/cli` (`webpack.config.js` extracts the app name from the entry path)       |
| Apps                    | `api-gateway`, `retail-microservice`, `inventory-microservice`, `notification-microservice` (stub) |
| Inter-service transport | RabbitMQ (`@nestjs/microservices`, request-response RPC + events; `amqp-connection-manager`)    |
| Persistence             | TypeORM 0.3 + MySQL 8.4 (single shared `retail_db`; `typeorm-naming-strategies` for snake_case) |
| Migrations              | TypeORM CLI driven by `migrations/config/data-source.ts`; two migrations on disk                |
| Cache                   | Redis (cache-aside applied to product stock — see ADR-002; `@nestjs/cache-manager` + `@keyv/redis`) |
| Auth                    | None — no `@nestjs/jwt` / `@nestjs/passport` / `passport-jwt` in `package.json`, no `auth/` folder anywhere |
| Logging                 | Pino via `nestjs-pino`; correlation-IDs via `CorrelationMiddleware` (see ADR-001)               |
| Observability           | OpenTelemetry / Jaeger — planned, not yet wired                                                 |
| Packaging               | Docker Compose (`docker-compose.yml` orchestrates MySQL, Redis, RabbitMQ, and the four apps)    |
| CI                      | GitHub Actions: `.github/workflows/ci-cd.yml` runs lint → build → unit → e2e on `push`/`PR` to `main` |
| Tests                   | Jest unit (7 suites / 59 tests) + a single E2E suite (`test/system-api.e2e-spec.ts`)            |
| Tooling                 | Yarn 4.12.0 (Berry, node-modules linker), Husky + lint-staged, Prettier, ESLint 10              |
| Docs                    | ADRs in `docs/adr/` (3-digit padding); two ADRs accepted (001-Pino, 002-Redis cache-aside); audit `docs/audits/audit-2026-05-08.md` |
| Path aliases            | `@retail-inventory-system/<name>` (defined in `tsconfig.json`, mirrored in jest, webpack, eslint) |

## 2. Actual directory tree (top three levels)

```
retail-inventory-system/
├── apps/
│   ├── api-gateway/
│   │   └── src/
│   │       ├── app/
│   │       │   ├── api/
│   │       │   │   ├── order/                 # POST /api/order, PUT /api/order/:id/confirm
│   │       │   │   │   ├── order.controller.ts
│   │       │   │   │   ├── order.module.ts
│   │       │   │   │   ├── pipes/order-confirm.pipe.ts
│   │       │   │   │   └── providers/         # one service per action
│   │       │   │   │       ├── order-create.service.ts
│   │       │   │   │       └── order-confirm.service.ts
│   │       │   │   └── product/               # GET /product/:id/stock
│   │       │   │       ├── product.controller.ts
│   │       │   │       ├── product.module.ts
│   │       │   │       ├── dto/product-stock-get-query.dto.ts
│   │       │   │       └── providers/product-stock-get.service.ts
│   │       │   ├── app.module.ts              # registers CorrelationMiddleware
│   │       │   └── common/utils/throw-rpc-error.util.ts
│   │       └── main.ts                        # bootstraps HTTP app on API_GATEWAY_PORT
│   ├── retail-microservice/
│   │   └── src/
│   │       ├── app/
│   │       │   ├── api/order/
│   │       │   │   ├── order.controller.ts    # @MessagePattern handlers for RETAIL_ORDER_*
│   │       │   │   ├── order.module.ts
│   │       │   │   ├── domain/                # OrderConfirmDomain — partial domain class
│   │       │   │   ├── pipes/                 # order-create.pipe.ts, order-confirm.pipe.ts
│   │       │   │   └── providers/
│   │       │   │       ├── order-create.service.ts
│   │       │   │       ├── order-confirm.service.ts
│   │       │   │       └── order-get.service.ts
│   │       │   ├── app.module.ts
│   │       │   └── common/entities/           # TypeORM @Entity classes (current "domain")
│   │       │       ├── customer.entity.ts
│   │       │       ├── order.entity.ts
│   │       │       ├── order-product.entity.ts
│   │       │       ├── order-product-status.entity.ts
│   │       │       └── order-status.entity.ts
│   │       └── main.ts                        # bootstraps RMQ microservice on retail_queue
│   ├── inventory-microservice/
│   │   └── src/
│   │       ├── app/
│   │       │   ├── api/product-stock/
│   │       │   │   ├── product-stock.controller.ts # @MessagePattern handlers for INVENTORY_*
│   │       │   │   ├── product-stock.module.ts
│   │       │   │   └── providers/
│   │       │   │       ├── product-stock-get.service.ts
│   │       │   │       └── product-stock-order-confirm.service.ts
│   │       │   ├── app.module.ts
│   │       │   └── common/
│   │       │       ├── entities/               # product, product-stock, product-stock-action, storage
│   │       │       └── modules/product-stock-common/
│   │       │           ├── product-stock-common.module.ts
│   │       │           ├── product-stock-common.service.ts # façade
│   │       │           ├── interfaces/        # add / cache / get
│   │       │           └── providers/
│   │       │               ├── product-stock-common-add.service.ts
│   │       │               ├── product-stock-common-get.service.ts
│   │       │               └── product-stock-common-cache.service.ts
│   │       └── main.ts                        # bootstraps RMQ microservice on inventory_queue
│   └── notification-microservice/
│       └── src/
│           ├── app/app.module.ts              # imports ConfigModule + LoggerModule only
│           └── main.ts                        # connects to notification_events queue, no handlers
├── libs/
│   ├── common/                                # already partially split — not "one mega lib"
│   │   ├── cache/cache.helper.ts              # cache-key registry (used by ADR-002)
│   │   ├── config/microservice-client-configuration.ts # ClientsModule async factory
│   │   ├── correlation/                       # CorrelationMiddleware + decorator + constants
│   │   ├── enums/                             # AppNameEnum, MicroserviceMessagePatternEnum,
│   │   │                                      # MicroserviceClientTokenEnum, MicroserviceQueueEnum
│   │   ├── interfaces/order-product-confirm.interface.ts
│   │   └── modules/                           # MicroserviceClientRetailModule, ...InventoryModule
│   ├── config/                                # cache-, config-, logger-, typeorm-module configs
│   ├── inventory/                             # IProductStockGetPayload, IProductStockOrderConfirmPayload,
│   │                                          # ProductStockGetResponseDto, INVENTORY_DEFAULT_STORAGE
│   └── retail/                                # OrderCreate(Dto|Response|Payload),
│                                              # OrderConfirm(Response|Interface), OrderProductStatusEnum,
│                                              # OrderStatusEnum, OrderProductConfirm interface
├── migrations/                                # TypeORM migrations (NOT inside an app)
│   ├── config/data-source.ts
│   ├── 1772600000000-InitStarterEntities.ts
│   └── 1774134626155-AddOrderProductIdToProductStock.ts
├── scripts/
│   ├── bash/start-dev.sh                      # used by `yarn start:dev`
│   ├── migration-create.ts                    # custom scaffold script
│   ├── seeds/*.sql                            # customer, order, order-product, product, product-stock
│   ├── test-db-seed.ts
│   └── utils/test-db-seed.util.ts
├── test/
│   ├── data-source/                           # E2E TypeORM data source (raw SQL assertions)
│   ├── jest.setup.ts
│   ├── system-api.e2e-spec.ts                 # single E2E suite covering the full order/stock flow
│   └── __snapshots__/system-api.e2e-spec.ts.snap
├── docs/
│   ├── adr/
│   │   ├── 001-structured-logging-with-pino.md   # Status: Accepted
│   │   └── 002-redis-cache-aside-product-stock.md # Status: Accepted
│   ├── architecture-migration-plan/           # this document tree (deleted on merge)
│   └── audits/audit-2026-05-08.md             # 17 issues across CACHE/TEST/CODE/DOCS prefixes
├── docker-compose.yml                         # mysql, redis, rabbitmq + 4 app services
├── Dockerfile                                 # single shared image, APP_NAME build arg
├── nest-cli.json                              # monorepo: true, four projects registered
├── tsconfig.json                              # path aliases @retail-inventory-system/*
├── eslint.config.mjs                          # ESLint 10 flat config, --max-warnings 0
├── jest.unit.config.js
├── jest.e2e.config.js
├── webpack.config.js                          # extracts appName from entry path
├── package.json                               # Yarn 4.12.0; build = `nest build --all`
└── yarn.lock
```

## 3. What is already well-structured

1. **Monorepo layout (`apps/` + `libs/`).** NestJS workspace mode (`monorepo: true` in `nest-cli.json`); each app builds independently to `dist/apps/<app>/main.js` and shares code via `@retail-inventory-system/<lib>` aliases.
2. **Service decomposition by capability.** Retail (orders), Inventory (stock), Notification (stub), API Gateway (HTTP edge) map cleanly to bounded contexts.
3. **API Gateway as a dedicated edge service.** HTTP/Swagger/Scalar/correlation concerns stay out of domain microservices.
4. **RabbitMQ as the inter-service bus.** Both request-response (`client.send()` from gateway / retail) and event handlers (`@MessagePattern` in retail and inventory) are in production use.
5. **TypeORM + MySQL with snake-naming.** `SnakeNamingStrategy` is wired in `libs/config/typeorm-module.config.ts`, so column names are consistent across services.
6. **Per-action service pattern.** Each feature folder uses `providers/<feature>-<action>.service.ts` (e.g. `order-create.service.ts`, `order-confirm.service.ts`, `product-stock-get.service.ts`). This is a partial step toward the use-case granularity the recommendation prescribes — the rename to `*.use-case.ts` and the introduction of ports is incremental rather than wholesale.
7. **Pino structured logging with correlation IDs.** ADR-001 documents the design; every cross-service log line carries a `correlationId` propagated via the RPC payload.
8. **Redis cache-aside for product stock.** ADR-002 documents the design; `ProductStockCommonService` façade hides cache from `ProductStockGetService`; explicit post-commit invalidation in `ProductStockOrderConfirmService`.
9. **Yarn 4 (Berry) workspaces + CI lint→build→unit→e2e.** GitHub Actions workflow `ci-cd.yml` enforces lint → build → unit → e2e in that order. Husky + lint-staged guard pre-commit. ESLint runs with `--max-warnings 0`.
10. **Docker Compose with healthchecks.** MySQL, Redis, RabbitMQ, and all four apps come up with explicit `condition: service_healthy` dependencies.

## 4. What still feels ad-hoc or inconsistent

1. **Entities double as domain models.** TypeORM `@Entity()` classes (e.g. `Order`, `OrderProduct`, `ProductStock`) are what services manipulate directly; there is no framework-free `domain/order.model.ts` enforcing invariants in a constructor. Retail does have one `domain/order-confirm.domain.ts` class (a state-transition computer) — a partial step.
2. **Services inject `Repository<X>` and `ClientProxy` directly.** `apps/retail-microservice/.../order-confirm.service.ts` injects both `@InjectRepository(Order)` and `@Inject(MicroserviceClientTokenEnum.INVENTORY_MICROSERVICE) ClientProxy`. There is no port boundary between application logic and TypeORM / RabbitMQ.
3. **DTOs cross direction boundaries.** A few `*Payload` interfaces (`IOrderCreatePayload`, `IProductStockGetPayload`) split inbound from response DTOs. But the gateway re-uses the same `OrderCreateDto` for HTTP body validation **and** RPC payload (`@retail-inventory-system/retail/dto/order-create.dto.ts`). Persistence shape and wire shape are not yet separated.
4. **Message-pattern enum is flat snake_case strings.** `MicroserviceMessagePatternEnum` uses `inventory_product_stock_get`, `retail_order_confirm`, etc. — neither dotted (`inventory.stock.get`) nor topic-routable. Fine for direct RPC but blocks routing-key-based consumers and mixed exchanges.
5. **No use-case granularity by name.** Per-action services are present but named `*.service.ts`, not `*.use-case.ts`. The boundary between "application logic" and "infrastructure plumbing" is not enforceable today (e.g. `OrderConfirmService` opens transactions on the injected repository inline).
6. **Notification is a stub.** `apps/notification-microservice/src/app/app.module.ts` registers `ConfigModule` + `LoggerModule` and nothing else. No consumers, no handlers, no notifier port.
7. **Auth is absent.** No JWT, no passport, no guards, no roles, no `auth/` folder. Every gateway route is unauthenticated. Adding auth is in scope as **separate** work in this migration (see task-06-build-auth-from-scratch).
8. **Observability stops at structured logs.** No OpenTelemetry SDK; no tracing across RabbitMQ; no `traceId`/`spanId` enrichment in Pino. Correlation IDs are the only cross-service link today.
9. **Test coverage is uneven.** 59 unit tests are concentrated in inventory's `product-stock-common` module + retail's `order-confirm.domain`. Gateway and notification have no unit tests; retail and inventory use cases beyond product-stock have no spec coverage. Single end-to-end suite (`test/system-api.e2e-spec.ts`) drives the full happy path through Docker-up infra.
10. **`libs/common` is mixed-purpose.** It holds cache helpers, correlation middleware, message-pattern enums, RabbitMQ client modules, and shared interfaces — wire-protocol contracts and cross-cutting infrastructure are co-mingled. Splitting is incremental rather than urgent because no consumer breaks today, but each new feature widens the surface.
11. **Open audit findings.** `docs/audits/audit-2026-05-08.md` lists 17 unresolved items (cache stampede protection, schema-version cache key, sort comparator bug, multi-tenant key collision, etc.). None block the architecture migration; each is independently in-scope for a future pass.

## 5. Specific pain points a better pattern can address

| Pain point                                          | Pattern that fixes it                                          |
| --------------------------------------------------- | -------------------------------------------------------------- |
| Business rules require DB to test                   | Hexagonal: domain entity ≠ TypeORM entity                      |
| Swapping Redis or RabbitMQ touches every service    | Ports + adapters in `infrastructure/`                          |
| Cross-service DTOs leak persistence shape           | Dedicated `libs/contracts/` for wire-only types                |
| "Where does X go?" debates                          | Layered folders with explicit eslint-boundaries rules          |
| Services holding repository + client + cache wiring | Use cases in `application/use-cases/*` + thin presentation     |
| Snake-case-string message patterns block routing    | `<service>.<aggregate>.<event>` routing keys in `libs/messaging` |
| Hard to add tracing later                           | OTel SDK started in dedicated lib, imported first in `main.ts` |
| Cache reach-through fragility (audit CACHE-006)     | `CachePort` interface — adapter swaps without touching call sites |
| Notification stub has no contract surface           | `NotifierPort` + per-channel adapters (log / email / webhook)  |
| No auth → every gateway route is open               | Dedicated auth migration task (task-06) with `libs/auth`       |

## 6. Planned-but-not-yet-implemented feature areas

1. **JWT + RBAC at the gateway** — built fresh in this migration as task-06 (`task-06-build-auth-from-scratch.md`). Adds `@nestjs/jwt`, `@nestjs/passport`, `passport`, `passport-jwt`; creates `libs/auth` (strategy / guards / decorators / module) and a hexagonal `auth/` module under the gateway with `application/use-cases/{login,refresh-token,validate-user}.use-case.ts`. Includes ADR (`docs/adr/NNN-jwt-rbac-at-the-gateway.md`), README "Authentication" section, and CLAUDE.md update.
2. **Notification service** — currently a stub. Needs a `NotifierPort`, at least a `LogNotifierAdapter`, and consumers for the events retail and inventory will publish. This is task-07 in the renumbered queue.
3. **Redis cache-aside generalization** — ADR-002 already covers product-stock; remaining read paths (order get, future product list, future stock list) need the same treatment, with a centralized `CACHE_KEYS` registry and write-side invalidation. Generalized in task-12.
4. **OpenTelemetry / Jaeger** — needs a `libs/observability/tracer.ts` started before `NestFactory.create*()`, RabbitMQ context propagation (traceparent in message properties), and Pino enrichment with `traceId`/`spanId`. Lit up in task-11.
5. **Test coverage expansion** — pure-domain unit tests for every use case, application-layer tests with mocked ports, integration tests for adapters. Not its own task; absorbed into the per-service alignment tasks (tasks 08–10).
6. **Architecture decision records back-fill** — ADRs 003+ for monorepo, hexagonal-per-service, TypeORM, RabbitMQ, JWT, OTel, eslint-boundaries, contracts/ddd/database lib split. Back-filled incrementally as tasks land; consolidated and indexed in task-14.
