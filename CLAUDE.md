# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
yarn start:dev                          # Start all services concurrently
yarn start:dev:api-gateway              # Start individual service
yarn start:dev:inventory-microservice
yarn start:dev:retail-microservice
yarn start:dev:notification-microservice

# Build
yarn build                              # Build all apps
yarn build:api-gateway                  # Build specific app

# Code quality (CI runs lint → build)
yarn lint                               # ESLint (max-warnings 0)
yarn lint:fix
yarn format:check
yarn format

# Database migrations
yarn migration:run                      # Apply pending migrations
yarn migration:revert                   # Revert last migration
yarn migration:create                   # Scaffold new migration
yarn migration:show                     # Show migration status
```

```bash
# Testing
yarn test:unit                          # Jest unit tests
yarn test:e2e                           # Full E2E (infra reload + tests)
yarn test:e2e:run                       # E2E tests only (infra must be running)
yarn test:infra:up                      # Start test infrastructure (MySQL, Redis, RabbitMQ)
yarn test:infra:down                    # Stop test infrastructure
yarn test:infra:reload                  # Recreate infra, run migrations, seed
yarn test:seed                          # Seed test database
```

## Architecture

NestJS monorepo with three active microservices and an API gateway, communicating via RabbitMQ.

```
apps/
  api-gateway/              # HTTP entry point (port 3000)
  inventory-microservice/   # Stock management (per-module hexagonal: modules/stock/)
  retail-microservice/      # Orders (per-module hexagonal: modules/orders/)
  notification-microservice # Hexagonal per-module template (consumes retail/inventory events, fans out via NotifierPort)
libs/
  auth/                     # JWT + RBAC framework-glue (AuthModule.forRootAsync, JwtStrategy, JwtAuthGuard, RolesGuard, @Public/@Roles/@CurrentUser, RoleEnum re-export)
  cache/                    # CachePort + RedisCacheAdapter + @Cacheable + cache-keys registry
  common/                   # Framework-free utilities (Result, DomainException, pagination types, utility types)
  config/                   # configModuleConfig (Joi env schema)
  contracts/                # Cross-service message and DTO contracts (auth, microservices, retail, inventory)
  database/                 # TypeORM base entity/repository, snake-naming strategy, DatabaseModule
  ddd/                      # Framework-free domain building blocks (Entity, AggregateRoot, ValueObject, DomainEvent, IRepositoryPort)
  messaging/                # RabbitMQ wiring — MessagingModule, MicroserviceClient*Module, MicroserviceClientConfiguration, RabbitmqClientFactory, ROUTING_KEYS, EXCHANGES
  observability/            # Pino LoggerModuleConfig + correlation middleware/decorator/types + OTel tracer.ts + TraceContextInterceptor + MetricsModule
migrations/                 # TypeORM migrations + data-source config
```

**Request flow:** HTTP → API Gateway (auth + global guards) → RabbitMQ (request-response) → Microservice → MySQL

**RabbitMQ queues:** `retail_queue`, `inventory_queue`, `notification_events` (the `notification` exchange constant is reserved for future topic-exchange routing — today the queue is bound to the default exchange).

**Message patterns (RPC + events, defined in libs/contracts/microservices and mirrored as `ROUTING_KEYS` in libs/messaging — wire format is dotted `<service>.<aggregate>.<action>`, see ADR-008):**
- `retail.order.create` — create order (API Gateway → Retail)
- `retail.order.confirm` — confirm order (API Gateway → Retail → Inventory)
- `retail.order.get` — get order by id (API Gateway → Retail)
- `retail.order.created` — event; published by Retail's `OrderRabbitmqPublisher` after `CreateOrderUseCase` persists the aggregate; consumed by Notification
- `retail.order.confirmed` — event; published by Retail's `OrderRabbitmqPublisher` when `ConfirmOrderUseCase` flips an Order to fully-confirmed; no cross-service consumer today (port surface reserved)
- `retail.order.cancelled` — event; reserved for the future cancel flow (no producer or consumer today)
- `inventory.product-stock.get` — query stock levels (API Gateway → Inventory)
- `inventory.order.confirm` — reserve stock for confirmed order products (Retail → Inventory)
- `inventory.stock.low` — event; published by Inventory's `StockRabbitmqPublisher` whenever a post-commit (productId, storageId) quantity sits at-or-below `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD`; consumed by Notification
- `notification.health.ping` — RMQ-transport health check on the Notification microservice

## Service Structure

The API Gateway, the Notification microservice, the Inventory microservice, and the Retail microservice are all on the per-module hexagonal layout (ADR-009, ADR-011, ADR-012, ADR-013).

### API Gateway (`apps/api-gateway/src/`)

```
src/
  app/app.module.ts            # top-level Nest module + CorrelationMiddleware wiring
  common/utils/                # shared utilities (e.g. throwRpcError)
  main.ts                      # first import: '@retail-inventory-system/observability/tracer'
  modules/
    retail/
      application/
        ports/                 # IRetailGatewayPort + RETAIL_GATEWAY_PORT (DI symbol)
        use-cases/             # CreateOrderUseCase, ConfirmOrderUseCase
      infrastructure/
        messaging/             # RetailRabbitmqAdapter (only place that holds ClientProxy)
        retail.module.ts       # binds RETAIL_GATEWAY_PORT -> RetailRabbitmqAdapter
      presentation/
        order.controller.ts    # POST /api/order, PUT /api/order/:id/confirm
        pipes/                 # OrderConfirmPipe — injects the port, not ClientProxy
    inventory/
      application/
        ports/                 # IInventoryGatewayPort + INVENTORY_GATEWAY_PORT
        use-cases/             # GetProductStockUseCase
      infrastructure/
        messaging/             # InventoryRabbitmqAdapter
        inventory.module.ts
      presentation/
        product.controller.ts  # GET /api/product/:productId/stock
        dto/                   # ProductStockGetQueryDto
```

The gateway also has `modules/auth/` — the only gateway module with a real `domain/` (User aggregate, Role value object) and the only one that owns DB state. See ADR-010.

```
modules/auth/
  domain/
    user.model.ts            # User aggregate (string id, email, passwordHash, roles, refreshTokenHash)
    role.model.ts            # RoleVO wrapping RoleEnum
    events/                  # UserRegistered, UserLoggedIn (audit-only today)
  application/
    ports/                   # IUserRepositoryPort, ITokenPort, IPasswordPort + DI symbols
    use-cases/               # Login, Refresh, Logout, Register, ValidateUser (consumed by libs/auth JwtStrategy)
    dto/                     # ILoginCommand, IRefreshCommand, ICurrentUserView
  infrastructure/
    persistence/             # UserEntity (TypeORM), UserMapper, UserTypeormRepository
    jwt/jwt-token.adapter.ts # ITokenPort impl using @nestjs/jwt
    argon2/argon2-password.adapter.ts
    auth.module.ts           # imports AuthLibModule.forRootAsync({ AUTH_USER_VALIDATOR -> ValidateUserUseCase })
  presentation/
    auth.controller.ts       # POST /auth/login, /auth/refresh, /auth/logout; GET /auth/me
    auth-admin.controller.ts # GET /auth/admin/ping (admin-only smoke endpoint)
    dto/                     # Login/Refresh/Token/CurrentUser DTOs (class-validator + Swagger)
```

**Boundary rule:** `ClientProxy` from `@nestjs/microservices` is allowed only inside `infrastructure/messaging/*-rabbitmq.{adapter,publisher}.ts`. Controllers, use-cases, and pipes inject the port symbol instead. Adapters use `ROUTING_KEYS` from `@retail-inventory-system/messaging` (the dotted constants, not the legacy `MicroserviceMessagePatternEnum`).

**Authentication conventions (gateway).** Every HTTP route is protected by default — global `JwtAuthGuard` and `RolesGuard` are wired in `app.module.ts` via `APP_GUARD`. Public routes opt out with `@Public()` from `@retail-inventory-system/auth`. Role-based authorization uses `@Roles(RoleEnum.X, …)`; controllers may also annotate themselves at the class level. Inject the authenticated user with `@CurrentUser()` (returns `ICurrentUser` from `@retail-inventory-system/contracts`). Passwords are hashed with **argon2id** (OWASP 2024 cost defaults — 19,456 KiB memory, 2 iterations, 1 thread; tunable via `AUTH_ARGON2_*` env). Refresh tokens are **rotated on every successful refresh**, with a hash of the live token persisted on the user row; reuse of a stale refresh token clears the live hash and returns 401. See [ADR-010](docs/adr/010-jwt-rbac-at-the-gateway.md).

### Microservices (per-module hexagonal layout)

The notification, inventory, and retail microservices are all on the per-module hexagonal layout. The notification module is the **canonical per-module template** — the other services follow its shape:

```
apps/notification-microservice/src/modules/notifications/
  domain/                       # Notification value object + NotificationChannelEnum
  application/
    ports/                      # INotifierPort + NOTIFIER symbol
    use-cases/                  # SendOrderNotificationUseCase, SendLowStockAlertUseCase
  infrastructure/
    consumers/                  # @EventPattern subscribers (RMQ): order-events, inventory-events
    delivery/                   # NOTIFIER adapters: log (default), email (TODO), webhook (TODO)
    notifications.module.ts     # binds NOTIFIER -> LogNotifierAdapter (single-line rebind to swap)
  presentation/
    health.controller.ts        # @MessagePattern('notification.health.ping')
```

The inventory microservice's single `stock` bounded context follows the same split (ADR-012):

```
apps/inventory-microservice/src/modules/stock/
  domain/                         # StockItem aggregate (quantity / reservedQuantity invariants), Storage VO,
                                  #   StockReservedEvent, StockReleasedEvent, StockLowEvent
  application/
    ports/                        # IStockRepositoryPort, IStockCachePort, IStockEventsPublisherPort
                                  #   + STOCK_REPOSITORY, STOCK_CACHE, STOCK_EVENTS_PUBLISHER symbols
    use-cases/                    # GetStockUseCase, ReserveStockForOrderUseCase, AddStockUseCase
  infrastructure/
    persistence/                  # ProductStock / Product / Storage entities, StockItemMapper, StockTypeormRepository
    cache/stock.cache.ts          # STOCK_CACHE adapter; delegates get/set/delByPrefix to the generic CACHE_PORT
                                  #   (libs/cache). Keys go through CACHE_KEYS.inventoryStock per ADR-016.
                                  #   Write-path invalidation is reachable only through `withInvalidation(work,
                                  #   resolveItems, opts)` — the post-commit ordering is type-enforced (ADR-023).
    messaging/stock-rabbitmq.publisher.ts  # STOCK_EVENTS_PUBLISHER adapter; wraps ClientProxy.emit() + firstValueFrom
    stock.module.ts               # binds STOCK_REPOSITORY -> StockTypeormRepository, STOCK_CACHE -> StockCache,
                                  #   STOCK_EVENTS_PUBLISHER -> StockRabbitmqPublisher
  presentation/
    stock.controller.ts           # @MessagePattern handlers for INVENTORY_PRODUCT_STOCK_GET and INVENTORY_ORDER_CONFIRM
```

The notification microservice is RMQ-only (no HTTP). The retail microservice's single `orders` bounded context follows the same split (ADR-013):

```
apps/retail-microservice/src/modules/orders/
  domain/                         # Order aggregate (line-item invariants + status transitions),
                                  #   OrderProduct child entity, OrderStatus/OrderProductStatus VOs,
                                  #   CustomerRef VO, OrderCreated/OrderConfirmed/OrderCancelled events
  application/
    ports/                        # IOrderRepositoryPort, IOrderEventsPublisherPort,
                                  #   IInventoryConfirmGatewayPort + ORDER_REPOSITORY,
                                  #   ORDER_EVENTS_PUBLISHER, INVENTORY_CONFIRM_GATEWAY symbols
    use-cases/                    # CreateOrderUseCase, ConfirmOrderUseCase, GetOrderUseCase
  infrastructure/
    persistence/                  # Order / OrderProduct / OrderStatus / OrderProductStatus / Customer
                                  #   entities, OrderMapper, OrderProductMapper, CustomerMapper,
                                  #   OrderTypeormRepository
    messaging/                    # OrderRabbitmqPublisher (ORDER_EVENTS_PUBLISHER adapter; emits
                                  #   retail.order.created/confirmed/cancelled) +
                                  #   InventoryConfirmRabbitmqAdapter (INVENTORY_CONFIRM_GATEWAY
                                  #   adapter; wraps ClientProxy.send for inventory.order.confirm)
    orders.module.ts              # binds the three ports to their adapters
  presentation/
    orders.controller.ts          # @MessagePattern handlers for RETAIL_ORDER_CREATE / CONFIRM / GET
    pipes/                        # OrderCreatePipe (customer + product existence checks),
                                  #   OrderConfirmPipe (loads order line items for the use case)
```

## Shared Libraries

Import via path aliases defined in `tsconfig.json`:
- `@retail-inventory-system/contracts` — cross-service message and DTO contracts (plain TypeScript, no Nest decorators outside of `class-validator`/Swagger metadata on DTOs). Sub-areas: `microservices/` (queue/pattern/client-token/app-name enums, `ICorrelationPayload`), `retail/` (Order DTOs, enums, interfaces), `inventory/` (product-stock DTOs, types, constants — `INVENTORY_DEFAULT_STORAGE`, `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD`), `auth/` (`RoleEnum`, `ICurrentUser`, `IJwtAccessPayload`, `IJwtRefreshPayload` — framework-free; future microservices that validate tokens off-gateway depend on these).
- `@retail-inventory-system/auth` — Nest-aware framework glue for JWT + RBAC: `AuthModule.forRootAsync({ imports, providers, exports })` (registers `PassportModule` + `JwtModule` + `JwtStrategy` + `JwtAuthGuard` + `RolesGuard`, global), `AUTH_USER_VALIDATOR` port (apps bind a `IAuthUserValidator` here so the strategy can resolve a request user), decorators (`@Public`, `@Roles`, `@CurrentUser`), runtime `RoleEnum` re-export.
- `@retail-inventory-system/database` — TypeORM base. Exports `BaseEntity`, `BaseTypeormRepository`, `SnakeNamingStrategy` (re-export of `typeorm-naming-strategies`), and `DatabaseModule.forRoot(entities)` / `DatabaseModule.forFeature(entities)`. App modules call `DatabaseModule.forRoot(entities)` rather than constructing a TypeORM config directly.
- `@retail-inventory-system/messaging` — RabbitMQ wiring: `MessagingModule`, per-service `MicroserviceClient{Retail,Inventory,Notification}Module`, `MicroserviceClientConfiguration`, `RabbitmqClientFactory`, `ROUTING_KEYS` (dotted routing keys), `EXCHANGES` (reserved exchange names). Re-exports `MicroserviceQueueEnum` / `MicroserviceClientTokenEnum` from contracts.
- `@retail-inventory-system/cache` — Redis cache abstraction: `ICachePort` (get/set/del/wrap/**delByPrefix**/**singleFlight**), `CACHE_PORT` (DI token), `RedisCacheAdapter` (concrete `@nestjs/cache-manager` + `@keyv/redis` implementation with OTel spans on every op), `CacheModule` (a `@Global()` Nest module that binds the port to the adapter — register once at app root), `@Cacheable()` decorator, `CACHE_KEYS` registry (typed builders — apps may not write string cache-key literals), plus `CacheHelper` for backwards-compat. ADR-002 cache-aside contract preserved; ADR-016 generalizes the key convention to `ris:<service>:<aggregate>:<id>[:<facet>]` and adds the `delByPrefix` primitive; [ADR-021](docs/adr/021-cache-single-flight-and-ttl-jitter.md) adds the in-process `singleFlight(key, fn)` miss-dedupe primitive — concurrent calls with the same key share one loader invocation, rejections propagate to every waiter, and the entry is cleared on settlement so a rejected leader does not poison the key. The stock cache adapter applies ±10% TTL jitter on writes (ADR-021).
- `@retail-inventory-system/observability` — Pino logger + correlation + OTel bootstrap: `LoggerModuleConfig` (Pino setup with redaction, transport split, and the `logMethod` hook that injects active-span `traceId`/`spanId` into every log record — ADR-015), `CorrelationMiddleware`, `CorrelationId` decorator, `CORRELATION_ID_HEADER` constant, `ICorrelationPayload` (re-exported from contracts), OTel `tracer.ts` (side-effect import: configures `NodeSDK` + `OTLPTraceExporter` + auto-instrumentations and starts at module load — ADR-014), `TraceContextInterceptor` (placeholder; auto-instrumentation covers the cross-service flow today), `MetricsModule` (placeholder).
- `@retail-inventory-system/ddd` — framework-free domain building blocks: `Entity<TId>`, `AggregateRoot<TId>` (with `pullDomainEvents()`), `ValueObject<TProps>`, `DomainEvent<TAggregateId>`, `IRepositoryPort<TAggregate, TId>`. **No `@nestjs/*`, no TypeORM imports** — domain code is the consumer.
- `@retail-inventory-system/common` — framework-free utilities: `Result<T, E>`, `DomainException`, pagination types (`IPage`, `IPageRequest`), utility types (`Maybe`, `Nullable`).
- `@retail-inventory-system/config` — `configModuleConfig` (Joi env schema). App modules call `DatabaseModule.forRoot()` for TypeORM and `LoggerModuleConfig` from `@retail-inventory-system/observability` for Pino — there are no Nest-binding helpers in this lib.

**Forbidden imports.** Domain code (under `apps/*/src/.../domain/` and inside `libs/ddd`) MUST NOT import from `@retail-inventory-system/messaging`, `@retail-inventory-system/cache`, `@retail-inventory-system/observability`, `@retail-inventory-system/database`, or any `@nestjs/*` package. Reach those concerns via ports defined in `libs/ddd` (e.g. `IRepositoryPort`) or app-side ports.

**Boundaries rules are authoritative** (ADR-017). The per-layer / per-lib import constraints above — plus cross-service and cross-module isolation — are enforced by `eslint-plugin-boundaries` in `eslint.config.mjs`. When in doubt about where a file belongs, run `yarn lint` and let the rules answer; do not weaken a rule to make code pass. The bumper next to it is `tests/lint/architecture-lint.spec.ts`, a fixture-based regression suite that re-asserts each rule fires (so silent loosening of the config fails CI before the bad import lands).

**Cache-key convention** (ADR-016 + [ADR-022](docs/adr/022-cache-keys-tenant-and-schema-version.md)). Every cache key follows `ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]`. The `<version>` segment is a per-aggregate constant in `libs/cache/cache-keys.ts` (`INVENTORY_STOCK_KEY_VERSION`, `RETAIL_ORDER_KEY_VERSION` — currently `v1`); a breaking DTO shape change bumps the constant in one line, and pre-bump entries become unreachable on the next deploy. The `t:<tenantId>` segment is opt-in by argument (`opts?: { tenantId?: string }` on every builder) — a missing `tenantId` means single-tenant mode and the segment is omitted entirely (no silent `t:default:…`). Apps under `apps/*/src` MUST NOT write cache-key string literals — call a builder on `CACHE_KEYS` from `@retail-inventory-system/cache`. Apps MUST NOT import `@nestjs/cache-manager`, `@keyv/redis`, or the `cacheable` package directly — depend on `ICachePort`/`CACHE_PORT` (or a domain-shaped wrapper port like `IStockCachePort`). Write paths invalidate via `CACHE_KEYS.<aggregate>Prefix` + `port.delByPrefix`, awaited post-commit so the next read sees fresh data. The post-commit ordering is type-enforced on stock writes ([ADR-023](docs/adr/023-cache-invalidate-post-commit-by-type.md)): `IStockCachePort` has no public `invalidate`; callers route writes through `stockCache.withInvalidation(work, resolveItems, opts)`, which awaits `work` and only then fans out three internal `delByPrefix` calls per productId during the ADR-022 transition window (current v1 prefix, pre-v1 `inventoryStockLegacyPrefix`, and pre-ADR-016 `productStockPrefix`).


## Database

MySQL via TypeORM. Connection string from `DATABASE_URL` env var (docker-compose default: `mysql://retail:retailpass@mysql:3306/retail_db`).

Migration config is in `migrations/config/data-source.ts`. Entities live next to the bounded context that owns them: the inventory microservice's are at `apps/inventory-microservice/src/modules/stock/infrastructure/persistence/`, retail's at `apps/retail-microservice/src/modules/orders/infrastructure/persistence/`, and the gateway's `auth` module follows the same convention.

Run `docker-compose up` to start MySQL, RabbitMQ, and Redis locally.

## Architecture rules location

Architectural rules and the target state are recorded as ADRs under [`docs/adr/`](docs/adr/) — see [`docs/adr/index.md`](docs/adr/index.md) for the catalogue index. ADRs are the durable record. Existing ADRs use 3-digit padding (`001-…`, `020-…`); the next free number is `021`.

When making an architectural decision, write an ADR. The format is documented in [ADR-003](docs/adr/003-record-architecture-decisions.md) (record architecture decisions): Nygard hybrid (Status, Context, Decision, Alternatives, Consequences), 3-digit padding, one decision per file, slug describes the decision not the area.

## Operational notes

- **The first import in every app's `main.ts` MUST be `@retail-inventory-system/observability/tracer`.** Auto-instrumentation patches happen at module load — any HTTP / TypeORM / Redis / amqplib client `require()`'d before the tracer is invisible to OTel. Enforced by code review today; a future import-order ESLint rule would close the loop.
- **Redis cache-aside is generalized.** Product stock reads use cache-aside ([ADR-002](docs/adr/002-redis-cache-aside-product-stock.md)) with the `ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]` key convention ([ADR-016](docs/adr/016-cache-aside-generalized.md) + [ADR-022](docs/adr/022-cache-keys-tenant-and-schema-version.md)) and in-process single-flight + ±10% TTL jitter on the miss path ([ADR-021](docs/adr/021-cache-single-flight-and-ttl-jitter.md)). All audit items from `docs/audits/audit-2026-05-08.md` are closed: CACHE-006, CACHE-010, CACHE-011, CACHE-012 by ADR-016; CACHE-001 and CACHE-004 by ADR-021; CACHE-003 and CACHE-009 by ADR-022; CACHE-002 by [ADR-023](docs/adr/023-cache-invalidate-post-commit-by-type.md) (post-commit ordering type-enforced via `IStockCachePort.withInvalidation`); CACHE-005 by the `IStockCachePort.get` return shape carrying an `available` flag so `getOrLoad` skips the write-back path on a Redis-down read, collapsing the per-request warn-log count from three to one.
- **Cross-service events are fully wired.** `retail.order.created` is consumed by the notification microservice; `retail.order.confirmed` is published when an order is fully confirmed (no cross-service consumer yet; port surface reserved). `inventory.stock.low` is published by the inventory microservice when post-commit `(productId, storageId)` quantity is at-or-below `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD`.
- **OpenTelemetry + Jaeger are wired.** The compose overlay `docker-compose.observability.yml` provides Jaeger + an OTel collector for local dev; see [ADR-014](docs/adr/014-otel-exporter-otlp-http-and-jaeger.md). Pino log lines emitted inside an active span carry `traceId`/`spanId` ([ADR-015](docs/adr/015-pino-trace-correlation.md)).
- **One outstanding architectural exception (ARCH-LINT-EX-01).** The `EntityManager` from `typeorm` leaks across the stock module: the port declares it in method signatures (`apps/inventory-microservice/src/modules/stock/application/ports/stock.repository.port.ts`) and the use case injects it via `@InjectEntityManager` (`apps/inventory-microservice/src/modules/stock/application/use-cases/reserve-stock-for-order.use-case.ts`) so reads can scope inside a caller-owned transaction. Both files carry inline ESLint disables referencing the same tracking code (see ADR-017 §6). Closing the exception requires introducing an `ITransactionPort` abstraction that replaces both suppressions in lock-step — left as a follow-up.
