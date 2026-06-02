# Retail Inventory System

A microservices-based retail inventory management API built with NestJS, RabbitMQ, and MySQL.

## Architecture

Every service follows a per-module **hexagonal layout** (ports & adapters): `domain/` holds framework-free aggregates and value objects; `application/` holds use cases and the port interfaces they depend on; `infrastructure/` holds the concrete adapters (TypeORM repositories, RabbitMQ clients, Redis cache, etc.); `presentation/` holds HTTP controllers and `@MessagePattern` handlers. The boundaries are enforced by `eslint-plugin-boundaries` ([ADR-017](docs/adr/017-architecture-lint-via-eslint-boundaries.md)) — `yarn lint` is the source of truth for where a file should live.

The durable architectural artefacts are this `README.md` and the ADRs under [`docs/adr/`](docs/adr/). See [`docs/adr/index.md`](docs/adr/index.md) for the catalogue index (one row per ADR with status, date, and a one-line summary).

## Overview

The system handles order lifecycle management and product stock tracking across a distributed architecture. Clients interact with a single HTTP API gateway, which delegates work to specialized microservices over RabbitMQ.

### System diagram

```
┌───────────────────────────────────────────────────────────┐
│                       Client (HTTP)                       │
└─────────────────────────────┬─────────────────────────────┘
                              │
┌─────────────────────────────▼─────────────────────────────┐
│                  API Gateway port: 3000                   │
│                                                           │
│  Staff auth                                               │
│  POST  /api/auth/staff/login                              │
│  POST  /api/auth/login           (deprecated alias)       │
│  POST  /api/auth/refresh                                  │
│  POST  /api/auth/logout                                   │
│  GET   /api/auth/me                                       │
│  GET   /api/auth/admin/ping                               │
│                                                           │
│  Customer auth                                            │
│  POST  /api/auth/customer/register                        │
│  POST  /api/auth/customer/login                           │
│  GET   /api/auth/customer/me                              │
│                                                           │
│  IAM admin                                                │
│  GET   /api/iam/roles                                     │
│  POST  /api/iam/roles                                     │
│  PATCH /api/iam/roles/:id                                 │
│  POST  /api/iam/staff/:id/roles                           │
│  DELETE /api/iam/staff/:id/roles/:roleName                │
│                                                           │
│  Domain                                                   │
│  POST  /api/order                                         │
│  PUT   /api/order/:id/confirm                             │
│  GET   /api/product/:productId/stock                      │
└──────────────┬──────────────────────────────┬─────────────┘
               │           RabbitMQ           │
      RPC      │                              │     RPC
┌──────────────▼─────────┐  ┌─────────────────▼─────────────┐
│  Retail Microservice   │  │    Inventory Microservice     │
│                        │  │                               │
│  retail.order.create   │  │  inventory.product-stock.get  │
│  retail.order.confirm ─┼──► inventory.order.confirm       │
│  retail.order.get      │  │                               │
│                        │  │  Emits:                       │
│  Emits:                │  │  inventory.stock.low ─────────┼─┐
│  retail.order.created ─┼──┐                               │ │
│  retail.order.confirmed│  │  ┌────────────┐               │ │
└──────────────┬─────────┘  │  │   Redis    │◄──cache-aside─┤ │
               │            │  │ stock keys │               │ │
               │            │  └────────────┘               │ │
               │            │                               │ │
               │            └─────────────────┬─────────────┘ │
               │            MySQL             │               │
               └──────────────┬───────────────┘               │
                              │                               │
┌─────────────────────────────▼─────────────────────────────┐ │
│                        Shared DB                          │ │
│  staff_user / customer / role / permission                │ │
│  role_permissions / staff_user_roles                      │ │
│  order / order_product / product_stock                    │ │
│  storage / order_status / order_product_status            │ │
└───────────────────────────────────────────────────────────┘ │
                                                              │
┌─────────────────────────────────────────────────────────────▼─┐
│              Notification Microservice (RMQ)                  │
│  Listens: retail.order.created, inventory.stock.low           │
│  Fan-out via NotifierPort (log / email / webhook adapters)    │
└───────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────┐
│                  Catalog Microservice (RMQ)                   │
│  Binds: catalog_queue (product / variant context)             │
│  No message handlers registered yet                           │
└───────────────────────────────────────────────────────────────┘

OpenTelemetry: every service exports OTLP/HTTP spans through the
otel-collector → Jaeger UI at http://localhost:16686 (see the
"Distributed tracing" section below).
```

## Shared libraries

Path-aliased TypeScript libraries under `libs/`, imported as `@retail-inventory-system/<name>`:

| Library | Purpose |
| ------- | ------- |
| `contracts` | Cross-service message and DTO contracts (plain TypeScript). Sub-areas: `microservices/` (queue/pattern/client-token/app-name enums, `ICorrelationPayload`), `retail/`, `inventory/`, `auth/` (`RoleEnum`, `PermissionCodeEnum`, `ICurrentUser`, JWT payload interfaces, `IAuditLogPublisher` port + `AUDIT_LOG_PUBLISHER` token). |
| `database` | TypeORM base — `BaseEntity`, `BaseTypeormRepository`, `SnakeNamingStrategy`, and `DatabaseModule.forRoot(entities)` / `DatabaseModule.forFeature(entities)`. |
| `messaging` | RabbitMQ wiring — `MessagingModule`, per-service `MicroserviceClient{Retail,Inventory,Notification}Module`, `MicroserviceClientConfiguration`, `RabbitmqClientFactory`, `ROUTING_KEYS` and `EXCHANGES` constants. |
| `cache` | Cache port + Redis adapter — `ICachePort` (`get` / `set` / `del` / `wrap` / `delByPrefix` / `singleFlight`), `CACHE_PORT` DI token, `RedisCacheAdapter` (OTel-spanned), `CacheModule` (global), `@Cacheable()` decorator, `CACHE_KEYS` registry. |
| `observability` | Pino logger (`LoggerModuleConfig` with trace-correlation hook), `CorrelationMiddleware` + `@CorrelationId()` + `CORRELATION_ID_HEADER`, OTel bootstrap (`tracer.ts` side-effect import for `main.ts`), `TraceContextInterceptor` and `MetricsModule` placeholders. |
| `ddd` | Framework-free domain building blocks — `Entity`, `AggregateRoot`, `ValueObject`, `DomainEvent`, `IRepositoryPort`. No `@nestjs/*` or TypeORM imports. |
| `common` | Framework-free utilities (`Result`, `DomainException`, pagination types `IPage` / `IPageRequest`, `Maybe` / `Nullable`). |
| `config` | `configModuleConfig` (Joi env schema). |
| `auth` | Framework-glue for JWT + RBAC: `AuthModule.forRootAsync()`, `JwtStrategy`, `JwtAuthGuard`, `RolesGuard`, `PermissionsGuard`, `@Public()`, `@Roles()`, `@RequiresPermission()`, `@CurrentUser()`. The `RoleEnum` (`admin`, `catalog-manager`, `warehouse-staff`, `order-support`) and `PermissionCodeEnum` are re-exported from `@retail-inventory-system/contracts/auth` (the source of truth — framework-free). |

## Services

| Service                     | Transport                       | Responsibility                                       |
| --------------------------- | ------------------------------- | ---------------------------------------------------- |
| `api-gateway`               | HTTP (port 3000)                | Single entry point; routes requests to microservices |
| `retail-microservice`       | RabbitMQ (`retail_queue`)       | Order creation and confirmation                      |
| `inventory-microservice`    | RabbitMQ (`inventory_queue`)    | Stock queries and reservation                        |
| `notification-microservice` | RabbitMQ (`notification_events`) | Fan-out of `retail.order.created` / `inventory.stock.low` to a notifier port |
| `catalog-microservice`      | RabbitMQ (`catalog_queue`)      | Home of the product / variant catalog bounded context (no message handlers registered yet) |

### API Gateway layout

The API Gateway is on the per-module hexagonal layout introduced in [ADR-009](docs/adr/009-port-adapter-at-the-gateway.md):

```
apps/api-gateway/src/
├── app/app.module.ts
├── common/utils/                              # throwRpcError, etc.
├── main.ts                                    # first import: @retail-inventory-system/observability/tracer
└── modules/
    ├── retail/                                # talks to retail-microservice
    │   ├── application/
    │   │   ├── ports/retail-gateway.port.ts   # IRetailGatewayPort + RETAIL_GATEWAY_PORT
    │   │   └── use-cases/                     # CreateOrderUseCase, ConfirmOrderUseCase
    │   ├── infrastructure/
    │   │   ├── messaging/retail-rabbitmq.adapter.ts
    │   │   └── retail.module.ts
    │   └── presentation/
    │       ├── order.controller.ts            # POST/PUT /api/order…
    │       └── pipes/order-confirm.pipe.ts
    └── inventory/                             # talks to inventory-microservice
        ├── application/
        │   ├── ports/inventory-gateway.port.ts
        │   └── use-cases/get-product-stock.use-case.ts
        ├── infrastructure/
        │   ├── messaging/inventory-rabbitmq.adapter.ts
        │   └── inventory.module.ts
        └── presentation/
            ├── product.controller.ts          # GET /api/product/:id/stock
            └── dto/product-stock-get-query.dto.ts
```

The gateway also hosts a `modules/auth/` module (with the `StaffUser`, `Customer`, `RoleAggregate`, and `PermissionAggregate` aggregates) and a sibling `modules/iam/` module (the runtime-mutable admin shell over those aggregates). These are the only gateway modules with real `domain/` state and the only ones that own DB rows. `ClientProxy` is confined to `infrastructure/messaging/*-rabbitmq.adapter.ts`; everything else depends on the port symbol. See [ADR-010](docs/adr/010-jwt-rbac-at-the-gateway.md) and [ADR-024](docs/adr/024-rbac-v2-staffuser-customer-and-permissions.md).

### Per-module hexagonal layout

The notification microservice is the **canonical per-module template**. The inventory and retail microservices follow the same shape.

```
apps/notification-microservice/src/
├── app/app.module.ts                          # imports NotificationsModule + LoggerModule
├── main.ts                                    # first import: @retail-inventory-system/observability/tracer
└── modules/notifications/
    ├── domain/
    │   ├── notification.model.ts              # ValueObject<Notification>
    │   └── notification-channel.enum.ts
    ├── application/
    │   ├── ports/notifier.port.ts             # INotifierPort + NOTIFIER symbol
    │   └── use-cases/
    │       ├── send-order-notification.use-case.ts
    │       └── send-low-stock-alert.use-case.ts
    ├── infrastructure/
    │   ├── consumers/                          # RMQ @EventPattern subscribers
    │   │   ├── order-events.consumer.ts        # retail.order.created
    │   │   └── inventory-events.consumer.ts    # inventory.stock.low
    │   ├── delivery/                           # NOTIFIER implementations
    │   │   ├── log.notifier.adapter.ts         # default
    │   │   ├── email.notifier.adapter.ts       # scaffold (TODO)
    │   │   └── webhook.notifier.adapter.ts     # scaffold (TODO)
    │   └── notifications.module.ts             # binds NOTIFIER -> LogNotifierAdapter
    └── presentation/
        └── health.controller.ts                # @MessagePattern('notification.health.ping')
```

`LogNotifierAdapter` writes the structured notification to Pino at `info` level — useful as a development sink and as the canonical implementation. Switching to email or webhook delivery is a single `useExisting`/`useClass` rebind in `notifications.module.ts` once those adapters are implemented. The notification microservice is RMQ-only (no HTTP surface); its health check rides the same transport as the event subscribers. See [ADR-011](docs/adr/011-notifier-port-and-adapters.md).

The inventory microservice exposes a single `stock` bounded context laid out the same way:

```
apps/inventory-microservice/src/
├── app/app.module.ts                          # imports StockModule + LoggerModule + CacheModule + DatabaseModule
├── main.ts                                    # first import: @retail-inventory-system/observability/tracer
└── modules/stock/
    ├── domain/
    │   ├── stock-item.model.ts                # aggregate (quantity / reservedQuantity invariants)
    │   ├── storage.model.ts                   # ValueObject<Storage>
    │   └── events/                             # StockReservedEvent, StockReleasedEvent, StockLowEvent
    ├── application/
    │   ├── ports/
    │   │   ├── stock.repository.port.ts       # IStockRepositoryPort + STOCK_REPOSITORY symbol
    │   │   ├── stock-cache.port.ts            # IStockCachePort + STOCK_CACHE symbol
    │   │   ├── stock-events.publisher.port.ts # IStockEventsPublisherPort + STOCK_EVENTS_PUBLISHER symbol
    │   │   └── transaction.port.ts            # ITransactionPort + TRANSACTION_PORT symbol (opaque ITransactionScope; closes ARCH-LINT-EX-01)
    │   └── use-cases/
    │       ├── get-stock.use-case.ts          # cache-aside read
    │       ├── reserve-stock-for-order.use-case.ts
    │       └── add-stock.use-case.ts          # internal-only ledger append
    ├── infrastructure/
    │   ├── persistence/                       # TypeORM entities + StockTypeormRepository + StockItemMapper
    │   ├── cache/stock.cache.ts               # STOCK_CACHE adapter; preserves ADR-002 cache-aside contract
    │   ├── messaging/stock-rabbitmq.publisher.ts # STOCK_EVENTS_PUBLISHER adapter (emit → notification queue)
    │   └── stock.module.ts                    # binds all four port symbols → adapters (TRANSACTION_PORT → TypeormTransactionAdapter)
    └── presentation/
        └── stock.controller.ts                # @MessagePattern handlers for INVENTORY_PRODUCT_STOCK_GET / INVENTORY_ORDER_CONFIRM
```

`ClientProxy` lives only in `infrastructure/messaging/stock-rabbitmq.publisher.ts`; the use cases inject `STOCK_EVENTS_PUBLISHER` and await a plain Promise. See [ADR-012](docs/adr/012-stock-aggregate-and-port-adapter.md) for the aggregate boundaries and the port-and-adapter split.

The retail microservice exposes a single `orders` bounded context laid out the same way:

```
apps/retail-microservice/src/
├── app/app.module.ts                          # imports OrdersModule + LoggerModule + DatabaseModule
├── main.ts                                    # first import: @retail-inventory-system/observability/tracer
└── modules/orders/
    ├── domain/
    │   ├── order.model.ts                     # aggregate (non-empty lines, status transitions)
    │   ├── order-product.model.ts             # child entity inside the Order aggregate
    │   ├── customer.model.ts                  # CustomerRef VO
    │   ├── order-status.value-object.ts       # OrderStatusVO (PENDING / CONFIRMED)
    │   ├── order-product-status.value-object.ts
    │   └── events/                            # OrderCreatedEvent, OrderConfirmedEvent, OrderCancelledEvent
    ├── application/
    │   ├── ports/
    │   │   ├── order.repository.port.ts       # IOrderRepositoryPort + ORDER_REPOSITORY symbol
    │   │   ├── order-events.publisher.port.ts # IOrderEventsPublisherPort + ORDER_EVENTS_PUBLISHER symbol
    │   │   └── inventory-confirm.gateway.port.ts # IInventoryConfirmGatewayPort + INVENTORY_CONFIRM_GATEWAY symbol
    │   └── use-cases/
    │       ├── create-order.use-case.ts       # persists then publishes retail.order.created
    │       ├── confirm-order.use-case.ts      # cross-service: calls INVENTORY_CONFIRM_GATEWAY then updates
    │       └── get-order.use-case.ts          # header status lookup (consumed by gateway pipe)
    ├── infrastructure/
    │   ├── persistence/                       # Order/OrderProduct/Customer/OrderStatus/OrderProductStatus entities + mappers + OrderTypeormRepository
    │   ├── messaging/                          # OrderRabbitmqPublisher + InventoryConfirmRabbitmqAdapter
    │   └── orders.module.ts                   # binds all three port symbols → adapters
    └── presentation/
        ├── orders.controller.ts               # @MessagePattern handlers for RETAIL_ORDER_CREATE / CONFIRM / GET
        └── pipes/                              # OrderConfirmPipe (pre-RPC order line-item load)
```

`ClientProxy` is confined to the two adapters under `infrastructure/messaging/`; the use cases inject `INVENTORY_CONFIRM_GATEWAY` (for the cross-service reserve call) and `ORDER_EVENTS_PUBLISHER` (for `retail.order.created` / `retail.order.confirmed`). See [ADR-013](docs/adr/013-order-aggregate-and-cross-service-confirm.md) for the aggregate boundaries and the cross-service confirm flow.

## Getting Started

Start the infrastructure and all services:

```bash
docker-compose up -d mysql redis rabbitmq
yarn migration:run
yarn start:dev
```

## Scripts

### Development

| Script | Description |
| ------ | ----------- |
| `yarn start:dev` | Start all five services concurrently with watch reload (uses `scripts/bash/start-dev.sh`). |
| `yarn start:dev:api-gateway` | Start the API gateway with watch reload. |
| `yarn start:dev:inventory-microservice` | Start the inventory microservice with watch reload. |
| `yarn start:dev:retail-microservice` | Start the retail microservice with watch reload. |
| `yarn start:dev:notification-microservice` | Start the notification microservice with watch reload. |
| `yarn start:dev:catalog-microservice` | Start the catalog microservice with watch reload. |
| `yarn start:prod:<service>` | Run a built service from `dist/` (`api-gateway`, `inventory-microservice`, `retail-microservice`, `notification-microservice`, `catalog-microservice`). |

### Build

| Script | Description |
| ------ | ----------- |
| `yarn build` | Build all five apps via `nest build --all`. |
| `yarn build:<service>` | Build a single app — same five service names as above. |

### Lint / format

| Script | Description |
| ------ | ----------- |
| `yarn lint` | Full ESLint pass, includes `boundaries/*` and runs with `--max-warnings 0` (CI gate). |
| `yarn lint:fix` | Auto-fix what can be auto-fixed (prettier, sortable imports, etc.). |
| `yarn format` | Run prettier in write mode across `apps/**/*.ts` and `libs/**/*.ts`. |
| `yarn format:check` | Run prettier in check-only mode (CI gate). |

### Database migrations

| Script | Description |
| ------ | ----------- |
| `yarn migration:create` | Scaffold a new migration file under `migrations/` (uses `scripts/migration-create.ts`). |
| `yarn migration:run` | Apply every pending migration via the TypeORM CLI. |
| `yarn migration:revert` | Revert the last applied migration. |
| `yarn migration:show` | List every migration with its applied/pending status. |
| `yarn typeorm:migration-cli` | Raw TypeORM CLI hook used by the three commands above (pre-wired with the data-source config). |

### Testing

| Script | Description |
| ------ | ----------- |
| `yarn test:unit` | Run the Jest unit suite (`jest.unit.config.js`). |
| `yarn test:e2e` | Run `test:infra:reload` then the full E2E suite against a clean database. |
| `yarn test:e2e:run` | Run the E2E suite only — assumes infra is already up. |
| `yarn test:infra:up` | Start the MySQL / Redis / RabbitMQ containers and wait for them to be healthy. |
| `yarn test:infra:down` | Stop and remove the test infra containers (drops volumes and orphans). |
| `yarn test:infra:reload` | Tear down then recreate test infra, run migrations, and seed the database. |
| `yarn test:seed` | Seed the database with deterministic fixtures from `scripts/test-db-seed.ts`. |

### Architecture lint

The per-module hexagonal layout (`domain` → `application` → `infrastructure`/`presentation`, plus the `libs/*` boundaries documented in [ADR-017](docs/adr/017-architecture-lint-via-eslint-boundaries.md)) is enforced by `eslint-plugin-boundaries`. The rules live in `eslint.config.mjs` and are the **source of truth for where a file should live** — when in doubt, run `yarn lint` and let the plugin answer.

```bash
yarn lint              # full ESLint pass, includes boundaries/* (CI gate)
yarn lint:fix          # auto-fix what can be auto-fixed (prettier, etc.)
```

What the boundaries rules cover today:

- `domain/` may import only `@retail-inventory-system/ddd`, `lib-common`, and `lib-contracts` (enums/types). No `@nestjs/*`, no TypeORM, no Redis, no AMQP, no logging.
- `application/use-cases/` may import its own module's `domain`, `application/ports`, `application/dto`, plus the same lib set as domain — plus `lib-auth` for port interfaces. Concrete adapters and `@nestjs/cache-manager`/`@keyv/redis`/`@nestjs/typeorm` imports are rejected.
- `application/ports/` may import only `domain` types and `lib-contracts`. (The previous `ARCH-LINT-EX-01` exception in `apps/inventory-microservice/.../stock.repository.port.ts` is **closed**: `ITransactionPort` now hides TypeORM's `EntityManager` behind an opaque `ITransactionScope`, and the `application-use-case` denylist tightened to forbid both `@nestjs/typeorm` and bare `typeorm`. See [ADR-017](docs/adr/017-architecture-lint-via-eslint-boundaries.md) §6.)
- `infrastructure/` is the only layer allowed to touch concrete adapters (`typeorm`, `@keyv/redis`, `amqplib`, etc.).
- `presentation/` may import `application` layers + `lib-{auth,contracts,messaging,observability}`. Direct TypeORM repositories and Redis clients are rejected.
- `libs/contracts/` is plain TypeScript (`class-validator`, `class-transformer`, and `@nestjs/swagger` are the documented exceptions for HTTP/RPC DTOs).
- `libs/ddd/` is framework-free (no `@nestjs/*`, no TypeORM, no I/O packages).
- Cross-service (`apps/X` → `apps/Y`) and cross-module imports are rejected by `boundaries/dependencies` via the `{{from.captured.app}}` / `{{from.captured.module}}` template-matched selectors.

The rules are regression-tested in `tests/lint/architecture-lint.spec.ts` — every rule has a fixture that intentionally violates it and asserts the expected `boundaries/*` ruleId fires, so silent weakening of a rule fails the unit suite.

## API

### Orders

```
POST /api/order
PUT  /api/order/:id/confirm
```

### Stock

```
GET /product/:productId/stock
```

### Auth

```
# Staff
POST /api/auth/staff/login              # public
POST /api/auth/login                    # public — deprecated alias of /auth/staff/login
POST /api/auth/refresh                  # public
POST /api/auth/logout                   # bearer
GET  /api/auth/me                       # bearer
GET  /api/auth/admin/ping               # bearer + audit:read permission (smoke endpoint)

# Customer
POST /api/auth/customer/register        # public
POST /api/auth/customer/login           # public
GET  /api/auth/customer/me              # bearer

# IAM admin
GET   /api/iam/roles                    # bearer + iam:role-edit
POST  /api/iam/roles                    # bearer + iam:role-edit
PATCH /api/iam/roles/:id                # bearer + iam:role-edit
POST  /api/iam/staff/:id/roles          # bearer + iam:assign
DELETE /api/iam/staff/:id/roles/:roleName # bearer + iam:assign
```

Interactive API reference is available at `http://localhost:3000/api/reference` when the gateway is running.

## Authentication

Every gateway route is **protected by default** by a global guard pipeline: `JwtAuthGuard` (presence + signature), `RolesGuard` (role-bundle gating via `@Roles(...)`), and `PermissionsGuard` (precise per-code gating via `@RequiresPermission(...)`). Routes opt out of the first guard with `@Public()` (today: `/auth/staff/login`, `/auth/login`, `/auth/refresh`, `/auth/customer/register`, `/auth/customer/login`). See [ADR-010](docs/adr/010-jwt-rbac-at-the-gateway.md) for the original two-guard design and [ADR-024](docs/adr/024-rbac-v2-staffuser-customer-and-permissions.md) for the StaffUser/Customer split and the third guard.

Two subject kinds share the JWT pipeline:

- **`StaffUser`** — operators with one or more `Role`s, each binding a set of `Permission` codes. The access token's `permissions: string[]` claim is the union of those codes, inflated at login/refresh.
- **`Customer`** — buyer-side identity. No roles, no `permissions` claim — customer tokens never satisfy any `@RequiresPermission(...)` gate, by design.

### Login + refresh flow

```
1. POST /api/auth/staff/login { email, password }       # or /auth/customer/login
   ↳ verify password (argon2id)
   ↳ load roles → flatten permission codes (staff only)
   ↳ issue access JWT      (HS256, 15m by default, secret = JWT_ACCESS_SECRET,
                            payload includes roles + permissions for staff)
   ↳ issue refresh JWT     (HS256, 7d  by default, secret = JWT_REFRESH_SECRET)
   ↳ store argon2id hash of refresh JWT on the subject row
   ↳ return { accessToken, refreshToken, expiresIn }

2. POST /api/auth/refresh { refreshToken }
   ↳ verify signature + expiry
   ↳ argon2.verify(stored hash, presented token)
       ↳ mismatch ⇒ rotation reuse: clear the stored hash + 401
   ↳ re-inflate the staff permissions claim (so role-edits via /iam propagate)
   ↳ issue new access + refresh JWTs
   ↳ store new hash on the subject row
   ↳ return { accessToken, refreshToken, expiresIn }

3. POST /api/auth/logout (bearer)
   ↳ clear the subject's refresh-hash; subsequent /auth/refresh fails 401.
```

Refresh tokens **rotate on every successful refresh** — the old token is invalidated by hash replacement, and reuse trips a circuit-breaker that clears the live hash entirely. Permission edits made via the IAM admin endpoints take effect on the next refresh (≤15m by default); access tokens already in circulation continue to carry the pre-edit `permissions` claim.

### Roles and permissions

Roles are stored relationally in the `role` table and bound to permission codes through the `role_permissions` join. Staff users acquire roles through `staff_user_roles`. Permission codes themselves are the source-of-truth `PermissionCodeEnum` in [`libs/contracts/auth/permission.enum.ts`](libs/contracts/auth/permission.enum.ts); the four seeded role bundles live in `scripts/test-db-seed.ts` and are recreated by `yarn test:seed`.

| Role | Permission codes |
| --- | --- |
| `admin` | every code |
| `catalog-manager` | `catalog:read`, `catalog:write`, `catalog:publish` |
| `warehouse-staff` | `inventory:read`, `inventory:adjust`, `inventory:transfer` |
| `order-support` | `order:read`, `order:cancel`, `order:refund` |

Guard a controller method on a precise code with `@RequiresPermission()` from `@retail-inventory-system/auth`:

```ts
@Get('roles')
@RequiresPermission(PermissionCodeEnum.IAM_ROLE_EDIT)
public list(): Promise<RoleResponseDto[]> { … }
```

`@RequiresPermission(code)` is the **precise** gate — it checks `request.user.permissions` (the JWT-inflated claim). `@Roles(RoleEnum.X, …)` remains valid for **coarse** role-bundle gating where the precise permission isn't meaningful (rare; defaults are to use `@RequiresPermission`). Customer tokens have no `permissions` claim and never satisfy `@RequiresPermission`, so any code-gated route is a staff-only path by construction. See [docs/implementation/01-baseline-identity-staffuser-customer-rbac/03-permissions-guard-and-decorator.md](docs/implementation/01-baseline-identity-staffuser-customer-rbac/03-permissions-guard-and-decorator.md) for the inflation algorithm and the staleness window.

### Permissions

Every seeded permission code and the role bundles it appears in. Codes are kebab-case `<resource>:<action>` strings; the enum is at `libs/contracts/auth/permission.enum.ts`.

| Code | Roles |
| --- | --- |
| `catalog:read` | `admin`, `catalog-manager` |
| `catalog:write` | `admin`, `catalog-manager` |
| `catalog:publish` | `admin`, `catalog-manager` |
| `inventory:read` | `admin`, `warehouse-staff` |
| `inventory:adjust` | `admin`, `warehouse-staff` |
| `inventory:transfer` | `admin`, `warehouse-staff` |
| `order:read` | `admin`, `order-support` |
| `order:cancel` | `admin`, `order-support` |
| `order:refund` | `admin`, `order-support` |
| `iam:assign` | `admin` |
| `iam:role-edit` | `admin` |
| `audit:read` | `admin` |

### Required environment variables

| Variable | Default | Notes |
| -------- | ------- | ----- |
| `JWT_ACCESS_SECRET` | _(required, ≥ 32 chars)_ | HS256 signing key for access tokens. |
| `JWT_ACCESS_EXPIRES_IN` | `15m` | Lifetime as a `ms`-style string (`15m`, `2h`, `30s`). |
| `JWT_REFRESH_SECRET` | _(required, ≥ 32 chars; must differ from access)_ | HS256 signing key for refresh tokens. Distinct so it can be rotated independently. |
| `JWT_REFRESH_EXPIRES_IN` | `7d` | Lifetime of the refresh JWT. |
| `AUTH_ARGON2_MEMORY_COST` | `19456` (kib) | OWASP 2024 minimum for argon2id. |
| `AUTH_ARGON2_TIME_COST` | `2` | Iteration count. |
| `AUTH_ARGON2_PARALLELISM` | `1` | Threads. |

### Local development

`yarn test:seed` (or `yarn test:infra:reload`) inserts argon2id-hashed users — four staff (one per canonical role) and one customer:

| Email | Password | Role | Type |
| --- | --- | --- | --- |
| `admin@example.com` | `admin1234` | `admin` | StaffUser |
| `catalog@example.com` | `catalog1234` | `catalog-manager` | StaffUser |
| `warehouse@example.com` | `warehouse1234` | `warehouse-staff` | StaffUser |
| `support@example.com` | `support1234` | `order-support` | StaffUser |
| `customer@example.com` | `customer1234` | — | Customer |

Auth events emit Pino log lines with `userId` and `correlationId`, and (when wired) flow through the `AUDIT_LOG_PUBLISHER` port; the default binding is the in-process `NoOpAuditLogPublisher` (logs the event at `debug` under the `AuditLog` context). They are not fanned out to RabbitMQ today; if login alerts become a requirement, the notification microservice already has the consumer template ready — only an `auth.*` routing key plus a publisher binding are missing.

## Logging & Observability

All services emit structured JSON logs via [Pino](https://github.com/pinojs/pino) through `nestjs-pino`. Every log line includes a `correlationId` that ties a single client request to all log output it produces across every service.

### Format

| Environment | Format | Transport |
| --- | --- | --- |
| `NODE_ENV=production` | JSON (one object per line) | stdout |
| Any other value | Human-readable via `pino-pretty` | stdout |

Each JSON log line contains at minimum:

| Field | Description |
| --- | --- |
| `level` | Numeric severity — `20` debug, `30` info, `40` warn, `50` error |
| `time` | Unix timestamp in milliseconds |
| `app` | Service name (`api-gateway`, `retail-microservice`, etc.) |
| `context` | NestJS class that emitted the log |
| `correlationId` | Request trace ID (see below) |
| `msg` | Human-readable message |

### Correlation IDs

The `CorrelationMiddleware` runs on every inbound HTTP request at the API gateway:

1. If the request carries an `x-correlation-id` header, that value is used as-is.
2. Otherwise, a new UUID v4 is generated.

The ID is written back into the response headers and forwarded to every downstream RabbitMQ message payload. Microservices extract it from the payload and include it explicitly in every log call — no shared context required.

To trace a complete request across all services, filter by `correlationId`:

```bash
# From a log file
cat logs.json | jq 'select(.correlationId == "a1b2c3d4-e5f6-7890-abcd-ef1234567890")'

# Live from a running service (pipe stdout to jq)
yarn start:dev:retail-microservice 2>&1 | jq 'select(.correlationId == "a1b2c3d4-...")'
```

### `LOG_LEVEL` environment variable

Set `LOG_LEVEL` to override the default log level for all services.

| Value | Default environment |
| --- | --- |
| `debug` | development (`NODE_ENV` not `production`) |
| `info` | production (`NODE_ENV=production`) |

Available values: `trace`, `debug`, `info`, `warn`, `error`, `fatal`.

### Sample: correlated request across services

The following shows the full log output for a `PUT /api/order/1/confirm` request. Every line shares the same `correlationId` regardless of which process emitted it:

```json lines
{"level":30,"time":1748000000010,"app":"api-gateway","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","req":{"method":"PUT","url":"/api/order/1/confirm"},"msg":"incoming request"}
{"level":30,"time":1748000000015,"app":"api-gateway","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"OrderConfirmService","orderId":1,"msg":"Order confirmation in progress"}
{"level":30,"time":1748000000016,"app":"api-gateway","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"OrderConfirmService","pattern":"retail.order.confirm","msg":"Sending RPC to retail service"}
{"level":30,"time":1748000000020,"app":"retail-microservice","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"OrderConfirmService","orderId":1,"productCount":2,"msg":"Received RPC: confirm order"}
{"level":30,"time":1748000000021,"app":"retail-microservice","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"OrderConfirmService","pattern":"inventory.order.confirm","msg":"Sending RPC to inventory service"}
{"level":30,"time":1748000000025,"app":"inventory-microservice","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"ReserveStockForOrderUseCase","totalProducts":2,"pendingCount":2,"msg":"Received RPC: reserve order product stock"}
{"level":30,"time":1748000000040,"app":"inventory-microservice","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"ReserveStockForOrderUseCase","confirmedCount":2,"skippedCount":0,"msg":"Stock reserved for order products"}
{"level":30,"time":1748000000045,"app":"retail-microservice","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"OrderConfirmService","orderId":1,"confirmedCount":2,"msg":"Inventory stock confirmation received"}
{"level":30,"time":1748000000048,"app":"retail-microservice","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"OrderConfirmService","orderId":1,"msg":"Order fully confirmed"}
{"level":30,"time":1748000000060,"app":"api-gateway","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"OrderConfirmService","orderId":1,"statusId":"confirmed","msg":"Order successfully confirmed"}
{"level":30,"time":1748000000070,"app":"api-gateway","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","res":{"statusCode":200},"responseTime":60,"msg":"request completed"}
```

See [ADR-001](docs/adr/001-structured-logging-with-pino.md) for the rationale behind this design.

### Distributed tracing (OpenTelemetry + Jaeger)

In addition to correlation IDs, every service ships W3C-trace-context spans via OpenTelemetry. A single client request becomes a single trace that follows the HTTP entrypoint into the gateway and then across every RabbitMQ hop into the retail, inventory, and notification services. Every Pino log line emitted inside an active span is decorated with `traceId` and `spanId`, so logs and traces can be cross-filtered in any sink.

ADRs: [ADR-014](docs/adr/014-otel-exporter-otlp-http-and-jaeger.md) (OTLP/HTTP → collector → Jaeger), [ADR-015](docs/adr/015-pino-trace-correlation.md) (Pino `traceId`/`spanId` enrichment).

#### Required environment variables

| Var | Example | Notes |
| --- | --- | --- |
| `OTEL_SERVICE_NAME` | `api-gateway` | Distinct per service; Jaeger uses it for the "Service" filter |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | `http://otel-collector:4318/v1/traces` | OTLP/HTTP traces endpoint |
| `OTEL_RESOURCE_ATTRIBUTES` | `team=platform` | Optional; merged into the OTel `Resource` |
| `OTEL_SDK_DISABLED` | `false` | Set to `true` to short-circuit the SDK at boot (useful in some tests) |

In Docker Compose, the per-service `environment:` blocks already set `OTEL_SERVICE_NAME` and point `OTEL_EXPORTER_OTLP_ENDPOINT` at the in-cluster `otel-collector:4318`. For host-side `yarn start:dev`, copy `.env.example` to `.env.local` — the defaults there point at `http://localhost:4318/v1/traces`, which is where the `otel-collector` container publishes when the observability overlay is up.

#### Starting the observability stack

The Jaeger UI and the OpenTelemetry collector are kept in a **separate compose overlay** so day-to-day work doesn't pay for them:

```bash
# Bring up infra + observability together
docker compose -f docker-compose.yml -f docker-compose.observability.yml up

# Or stop just the observability containers when you're done
docker compose -f docker-compose.yml -f docker-compose.observability.yml stop jaeger otel-collector
```

| Endpoint | Purpose |
| --- | --- |
| `http://localhost:16686` | Jaeger UI — filter by service, search by trace ID |
| `http://localhost:4317` | OTLP/gRPC ingress on the collector |
| `http://localhost:4318` | OTLP/HTTP ingress on the collector (apps publish here) |

The collector config lives at [`infrastructure/otel-collector-config.yaml`](infrastructure/otel-collector-config.yaml) and is a single pipeline: OTLP receiver → `batch` processor → OTLP exporter to Jaeger (with a `debug` exporter for visibility during local development).

#### Finding a trace

1. Open Jaeger at <http://localhost:16686>.
2. Pick a service (e.g. `api-gateway`) and an operation (e.g. `PUT /api/order/:id/confirm`).
3. The matching trace shows spans from all four services, including the AMQP `publish` / `process` pairs that connect the gateway → retail → inventory → notification flow.
4. To go from a log line back to the trace, copy `traceId` from any service's log and paste it into Jaeger's "Lookup by Trace ID" box.

#### The "first import in `main.ts`" rule

Every service's `main.ts` must `import '@retail-inventory-system/observability/tracer';` as its **very first import**. The tracer bootstrap registers OpenTelemetry's auto-instrumentations (HTTP, MySQL, Redis, amqplib), and those have to run before any of the patched modules are required — otherwise the instrumentation does nothing and spans are silently missing. This rule is enforced by code review today; a future eslint rule for import ordering would close the loop.

## Caching

The product stock query (`GET /product/:productId/stock`) reads from an append-only `product_stock` ledger. Each row records a delta (positive or negative) against a `(productId, storageId)` pair, so producing a current balance requires a `SUM(quantity) ... GROUP BY storageId` aggregation. Aggregation cost grows linearly with the row count, while the read pattern is heavy and the write pattern is comparatively light — a good fit for caching.

The Inventory microservice caches stock query responses in Redis using the **cache-aside (lazy loading)** pattern. `GetStockUseCase` orchestrates the cache-aside read; `StockCache` (the `STOCK_CACHE` adapter) is a thin domain-shaped wrapper over the generic `CACHE_PORT`; `StockTypeormRepository` materializes the SUM/GROUP BY aggregate. The presentation-layer `StockController` is unaware of the cache.

The cache layer follows the conventions formalized in [ADR-016](docs/adr/016-cache-aside-generalized.md): every cache key is built via `CACHE_KEYS.*` (no string literals in `apps/*/src`), and apps depend on `ICachePort` rather than `@nestjs/cache-manager` directly.

### Read flow

```
1. Client request                → GetStockUseCase.execute()
2. STOCK_CACHE.get(key)          → hit?  return cached DTO, done
                                 → miss? continue
3. STOCK_REPOSITORY.aggregateForProduct(...)  → SUM/GROUP BY against product_stock
4. STOCK_CACHE.set(key, data, TTL) → populate cache
5. Return DTO                    → reply to client
```

Reads inside a caller-owned `EntityManager` (i.e., inside an open transaction) bypass the cache to avoid persisting uncommitted state.

### Cache key

```
ris:inventory:stock:v1:<productId>:__all__                       # no storageIds filter
ris:inventory:stock:v1:<productId>:<storageIds-joined-by-comma>  # e.g. ris:inventory:stock:v1:42:storage-a,storage-b
```

Storage IDs are sorted with `localeCompare` so callers passing the same set in different orders generate identical keys. The `v1` segment is the per-aggregate schema-version constant (`INVENTORY_STOCK_KEY_VERSION` in `libs/cache/cache-keys.ts`); a breaking DTO shape change bumps it in one line and pre-bump entries become unreachable on the next deploy. Built by `CACHE_KEYS.inventoryStock(productId, storageIds, opts?)`; an optional `{ tenantId }` argument prefixes the key with `t:<tenantId>:` for future multi-tenant use (omitted entirely when absent — never defaulted). Two legacy prefixes are still wiped by the SCAN-based invalidate path so a rolling deploy can sweep entries written under the pre-v1 (`ris:inventory:stock:<productId>:`) and pre-ADR-016 (`stock:<productId>:`) conventions.

The general key convention is `ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]` (see [ADR-022](docs/adr/022-cache-keys-tenant-and-schema-version.md)). `CACHE_KEYS.retailOrder(orderId)` follows the same shape (no caller today; reserved for a future read path).

### TTL

| Env var                     | Default (ms) | Role                                                                 |
| --------------------------- | ------------ | -------------------------------------------------------------------- |
| `CACHE_TTL_MS_DEFAULT`      | `60000`      | Global default applied by the Cache module to any unscoped `set()`.  |
| `CACHE_TTL_MS_PRODUCT_STOCK`| `60000`      | TTL applied explicitly when caching a stock query response.          |

TTL is a safety net, not the primary freshness mechanism — explicit invalidation is.

Per [ADR-021](docs/adr/021-cache-single-flight-and-ttl-jitter.md), `StockCache.set` applies a uniform ±10% jitter to the configured TTL before writing to Redis (so a batch of writes landing within one event-loop tick does not expire on the same wall-clock band). The jittered value is floored to the integer-ms contract of `ICachePort.set` and is always ≥ `ttl * 0.9`, so the TTL safety-net role is preserved.

### Miss-path single-flight

Per [ADR-021](docs/adr/021-cache-single-flight-and-ttl-jitter.md), concurrent cache misses on the same `(productId, storageIds)` key fan out to a single `repository.aggregateForProduct` call per process. The primitive lives on `ICachePort.singleFlight(key, fn)`; `StockCache.getOrLoad` composes it with the cache-aside read+write so `GetStockUseCase` never sees the dedupe machinery. A rejected loader propagates to every waiter (no silent retry-and-fan-out), and the in-flight slot is cleared on settlement so a failed leader does not poison the key for the next caller.

### Invalidation

When `ReserveStockForOrderUseCase` reserves stock for a confirmed order, it wraps the transaction in `stockCache.withInvalidation(work, resolveItems, { correlationId })` — a callback-based helper that awaits `work()` first and only then derives the invalidation items and fans out the prefix deletes. The post-commit ordering is enforced by the helper's type signature ([ADR-023](docs/adr/023-cache-invalidate-post-commit-by-type.md)): `IStockCachePort` has no public `invalidate(...)`, so a future contributor cannot accidentally call it from inside the transaction body, and a rejected `work` propagates without touching the cache.

Invalidation issues three `delByPrefix` calls per affected `productId` during the transition window (the current `v1` prefix, the pre-v1 `inventoryStockLegacyPrefix`, and the pre-ADR-016 `productStockPrefix` — see [ADR-022](docs/adr/022-cache-keys-tenant-and-schema-version.md) §4). Each `delByPrefix` does `SCAN MATCH <prefix>*` and `UNLINK`s every matching key. `UNLINK` (vs `DEL`) frees memory asynchronously on the Redis side, avoiding a blocking O(N) delete on Redis's main thread.

### Tracing

Each cache call opens an OTel span (`cache.get`, `cache.set`, `cache.del`, `cache.wrap`, `cache.delByPrefix`, `cache.singleFlight`) with `cache.key`, `cache.hit`, `cache.keys_unlinked` (for prefix deletes), and `cache.singleflight.joined` (true when the call attached to an existing leader) attributes. Hits and misses are visible in Jaeger end-to-end.

### Graceful degradation

Every cache operation is wrapped in a `try/catch` that logs a `warn` and swallows the error:

- **Read failure** → returns `undefined` (the same contract as a miss); the façade falls through to the DB and the request succeeds.
- **Write failure** → swallowed; the response is still returned to the client.
- **Invalidation failure** → swallowed; the entry remains until its TTL expires.

A Redis outage degrades latency, never correctness — no path throws to the client because the cache is unavailable.

### Inspecting the cache

```bash
# List every cached stock entry across all products
redis-cli --scan --pattern 'ris:inventory:stock:v1:*'

# Read a specific entry
redis-cli GET 'ris:inventory:stock:v1:42:__all__'

# Check remaining TTL (in ms) for a key
redis-cli PTTL 'ris:inventory:stock:v1:42:__all__'

# Manually invalidate every cached entry for a single product
redis-cli --scan --pattern 'ris:inventory:stock:v1:42:*' | xargs -r redis-cli UNLINK
```

See [ADR-002](docs/adr/002-redis-cache-aside-product-stock.md) for the original design and [ADR-016](docs/adr/016-cache-aside-generalized.md) for the generalized key convention + port-based invalidation.
