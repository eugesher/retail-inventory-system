# Retail Inventory System

A microservices-based retail inventory management API built with NestJS, RabbitMQ, and MySQL.

## Architecture migration in progress

This branch (`RIS-25-Architecture-migration`) is migrating the codebase to a per-module hexagonal layout (Brocoders-style ports & adapters) per service. The migration plan, the per-task scripts, and the carryover files all live under [`docs/architecture-migration-plan/`](docs/architecture-migration-plan/).

- Plan overview: [`docs/architecture-migration-plan/architecture-migration-plan.md`](docs/architecture-migration-plan/architecture-migration-plan.md)
- Task queue: [`docs/architecture-migration-plan/tasks/`](docs/architecture-migration-plan/tasks/) — `task-01` is the reconciliation step; tasks `02`–`14` execute the migration in order.
- Each task produces a `_carryover-NN.md` next to it. The next task reads it as its first action.

The `tasks/` folder and every `_carryover-NN.md` are **scratch** for the migration and **will be deleted before this branch merges into `main`**. The durable architectural artefacts are this `README.md`, [`CLAUDE.md`](CLAUDE.md), and the ADRs under [`docs/adr/`](docs/adr/).

### Migration baseline

[`docs/baseline/`](docs/baseline/) holds frozen copies of the configuration files, test-coverage report, and workspace listing as they were at the start of the migration (commit `04713bb`, captured 2026-05-09). This folder is **read-only** — captured as the pre-migration snapshot so later phases can diff against it. Do not edit these files; if a config drifts from baseline, that drift is the diff the migration is producing.

## Overview

The system handles order lifecycle management and product stock tracking across a distributed architecture. Clients interact with a single HTTP API gateway, which delegates work to specialized microservices over RabbitMQ.

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│                       Client (HTTP)                       │
└─────────────────────────────┬─────────────────────────────┘
                              │
┌─────────────────────────────▼─────────────────────────────┐
│                  API Gateway port: 3000                   │
│                                                           │
│  POST  /api/order                                         │
│  PUT   /api/order/:id/confirm                             │
│  GET   /product/:productId/stock                          │
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
│  retail.order.confirmed│  │                               │ │
└──────────────┬─────────┘  └─────────────────┬─────────────┘ │
               │                              │               │
               │            MySQL             │               │
               └──────────────┬───────────────┘               │
                              │                               │
┌─────────────────────────────▼─────────────────────────────┐ │
│                         Retail DB                         │ │
│                                                           │ │
│  order                                                    │ │
│  order_product                                            │ │
│  product_stock                                            │ │
└───────────────────────────────────────────────────────────┘ │
                                                              │
┌─────────────────────────────────────────────────────────────▼─┐
│              Notification Microservice (RMQ)                  │
│  Listens: retail.order.created, inventory.stock.low           │
│  Fan-out via NotifierPort (log / email / webhook adapters)    │
└───────────────────────────────────────────────────────────────┘
```

## Shared libraries

Path-aliased TypeScript libraries under `libs/`, imported as `@retail-inventory-system/<name>`:

| Library | Purpose |
| ------- | ------- |
| `contracts` | Cross-service message and DTO contracts (plain TypeScript). Sub-areas: `microservices/` (queue/pattern/client-token/app-name enums, `ICorrelationPayload`), `retail/`, `inventory/`. |
| `database` | TypeORM base — `BaseEntity`, `BaseTypeormRepository`, `SnakeNamingStrategy`, and `DatabaseModule.forRoot(entities)` / `DatabaseModule.forFeature(entities)`. |
| `messaging` | RabbitMQ wiring — `MessagingModule`, per-service `MicroserviceClient{Retail,Inventory,Notification}Module`, `MicroserviceClientConfiguration`, `RabbitmqClientFactory`, `ROUTING_KEYS` and `EXCHANGES` constants. |
| `cache` | Cache port + Redis adapter — `ICachePort`, `RedisCacheAdapter`, `CacheModule`, `@Cacheable()` decorator, `CACHE_KEYS` registry. Existing `CacheHelper` is re-exported here for compatibility. |
| `observability` | Pino logger + correlation-ID middleware/decorator/types, OTel `tracer.ts` shell (filled in task-10), `MetricsModule` placeholder, `TraceContextInterceptor` stub. |
| `ddd` | Framework-free domain building blocks — `Entity`, `AggregateRoot`, `ValueObject`, `DomainEvent`, `IRepositoryPort`. No `@nestjs/*` or TypeORM imports. |
| `common` | Slimmed framework-free utilities (`Result`, `DomainException`, pagination types, utility types). The `cache/`, `correlation/`, and `modules/` subfolders are now one-release shims pointing at `libs/{cache,observability,messaging}`. Removed in task-14. |
| `config` | `configModuleConfig` (Joi env schema). `LoggerModuleConfig` and `cacheModuleConfig` are now shims pointing at `libs/observability` and `libs/cache` respectively; `TypeormModuleConfig` is also a shim — use `DatabaseModule.forRoot()` instead. All three shims are removed in task-14. |
| `inventory`, `retail` | One-release shims that re-export `@retail-inventory-system/contracts`. Removed in task-14. |
| `auth` | Framework-glue for JWT + RBAC: `AuthModule.forRootAsync()`, `JwtStrategy`, `JwtAuthGuard`, `RolesGuard`, `@Public()`, `@Roles()`, `@CurrentUser()`. The `RoleEnum` (`admin`, `customer`) is re-exported from `@retail-inventory-system/contracts/auth` (the source of truth — framework-free). |

## Services

| Service                     | Transport                       | Responsibility                                       |
| --------------------------- | ------------------------------- | ---------------------------------------------------- |
| `api-gateway`               | HTTP (port 3000)                | Single entry point; routes requests to microservices |
| `retail-microservice`       | RabbitMQ (`retail_queue`)       | Order creation and confirmation                      |
| `inventory-microservice`    | RabbitMQ (`inventory_queue`)    | Stock queries and reservation                        |
| `notification-microservice` | RabbitMQ (`notification_events`) | Fan-out of `retail.order.created` / `inventory.stock.low` to a notifier port |

### API Gateway layout

The API Gateway is on the per-module hexagonal layout introduced in [ADR-009](docs/adr/009-port-adapter-at-the-gateway.md). Microservices remain on the legacy flat layout until tasks 07–09 of the migration:

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

The gateway has no `domain/` of its own — task-06 will add `modules/auth/` with a real `domain/` (User, Role). `ClientProxy` is confined to `infrastructure/messaging/*-rabbitmq.adapter.ts`; everything else depends on the port symbol.

### Per-module hexagonal layout

The notification microservice established the **canonical per-module template** for the bigger services. The inventory microservice (task-08) and the retail microservice (task-09) have both been reshaped into the same layout.

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
    │   │   └── stock-events.publisher.port.ts # IStockEventsPublisherPort + STOCK_EVENTS_PUBLISHER symbol
    │   └── use-cases/
    │       ├── get-stock.use-case.ts          # cache-aside read
    │       ├── reserve-stock-for-order.use-case.ts
    │       └── add-stock.use-case.ts          # internal-only ledger append
    ├── infrastructure/
    │   ├── persistence/                       # TypeORM entities + StockTypeormRepository + StockItemMapper
    │   ├── cache/stock-redis.cache.ts         # STOCK_CACHE adapter; preserves ADR-002 cache-aside contract
    │   ├── messaging/stock-rabbitmq.publisher.ts # STOCK_EVENTS_PUBLISHER adapter (emit → notification queue)
    │   └── stock.module.ts                    # binds all three port symbols → adapters
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
        └── pipes/                              # OrderCreatePipe + OrderConfirmPipe (pre-RPC validation/load)
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

| Script                   | Description                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `yarn test:seed`         | Populate the database with deterministic test fixtures (products, orders, stock records) defined in `scripts/seeds/*.sql`                                          |
| `yarn test:infra:reload` | Reset and reprovision the full local environment: tears down existing containers and volumes, starts MySQL/Redis/RabbitMQ, runs migrations, and seeds the database |
| `yarn test:e2e`          | Run `test:infra:reload` then execute the E2E test suite against a clean database                                                                                   |

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
POST /api/auth/login         # public
POST /api/auth/refresh       # public
POST /api/auth/logout        # bearer
GET  /api/auth/me            # bearer
GET  /api/auth/admin/ping    # bearer + admin role (smoke endpoint)
```

Interactive API reference is available at `http://localhost:3000/api/reference` when the gateway is running.

## Authentication

Every gateway route is **protected by default** by a global `JwtAuthGuard`. Routes opt out with `@Public()` (currently only `/auth/login` and `/auth/refresh`). Role-based authorization is layered on top via `@Roles(RoleEnum.X, …)` on controllers or methods, evaluated by a global `RolesGuard`. See [ADR-010](docs/adr/010-jwt-rbac-at-the-gateway.md) for the rationale.

### Login + refresh flow

```
1. POST /api/auth/login { email, password }
   ↳ verify password (argon2id)
   ↳ issue access JWT      (HS256, 15m by default, secret = JWT_ACCESS_SECRET)
   ↳ issue refresh JWT     (HS256, 7d  by default, secret = JWT_REFRESH_SECRET)
   ↳ store argon2id hash of refresh JWT on the user row
   ↳ return { accessToken, refreshToken, expiresIn }

2. POST /api/auth/refresh { refreshToken }
   ↳ verify signature + expiry
   ↳ argon2.verify(stored hash, presented token)
       ↳ mismatch ⇒ rotation reuse: clear the stored hash + 401
   ↳ issue new access + refresh JWTs
   ↳ store new hash on the user row
   ↳ return { accessToken, refreshToken, expiresIn }

3. POST /api/auth/logout (bearer)
   ↳ clear the user's refresh-hash; subsequent /auth/refresh fails 401.
```

Refresh tokens **rotate on every successful refresh** — the old token is invalidated by hash replacement, and reuse trips a circuit-breaker that clears the live hash entirely.

### Roles

Two seeded roles, defined as the `RoleEnum` in [`libs/contracts/auth/role.enum.ts`](libs/contracts/auth/role.enum.ts):

| Role | Description |
| ---- | ----------- |
| `customer` | Default role. May `POST /api/order`, `PUT /api/order/:id/confirm`, `GET /product/:id/stock`. |
| `admin` | Inherits customer access (admins seed with both roles). May additionally hit any route guarded by `@Roles(RoleEnum.ADMIN)` (today only the smoke endpoint `GET /api/auth/admin/ping`). |

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

`yarn test:seed` (or `yarn test:infra:reload`) inserts two argon2id-hashed users:

| Email | Password | Roles |
| ----- | -------- | ----- |
| `admin@example.com` | `admin1234` | `admin`, `customer` |
| `customer@example.com` | `customer1234` | `customer` |

Auth events (`UserLoggedIn`, `LoginFailed`, `RefreshTokenRotated`, `LogoutPerformed`) emit Pino log lines with `userId` and `correlationId`. They are not fanned out to RabbitMQ today; if login alerts become a requirement, the notification microservice already has the consumer template ready — only an `auth.user-logged-in` routing key plus a publisher in `LoginUseCase` are missing.

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
{"level":30,"time":1748000000016,"app":"api-gateway","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"OrderConfirmService","pattern":"retail_order_confirm","msg":"Sending RPC to retail service"}
{"level":30,"time":1748000000020,"app":"retail-microservice","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"OrderConfirmService","orderId":1,"productCount":2,"msg":"Received RPC: confirm order"}
{"level":30,"time":1748000000021,"app":"retail-microservice","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"OrderConfirmService","pattern":"inventory_order_confirm","msg":"Sending RPC to inventory service"}
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

Every service's `main.ts` must `import '@retail-inventory-system/observability/tracer';` as its **very first import**. The tracer bootstrap registers OpenTelemetry's auto-instrumentations (HTTP, MySQL, Redis, amqplib), and those have to run before any of the patched modules are required — otherwise the instrumentation does nothing and spans are silently missing. This rule is enforced by code review today; an eslint rule may follow in task-12.

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
ris:inventory:stock:<productId>:__all__                       # no storageIds filter
ris:inventory:stock:<productId>:<storageIds-joined-by-comma>  # e.g. ris:inventory:stock:42:storage-a,storage-b
```

Storage IDs are sorted with `localeCompare` so callers passing the same set in different orders generate identical keys. Built by `CACHE_KEYS.inventoryStock(productId, storageIds)` in `libs/cache/cache-keys.ts`. The legacy `stock:<productId>:*` builder is retained so the SCAN-based invalidate path can wipe entries written under the previous prefix during a rolling deploy.

The general key convention is `ris:<service>:<aggregate>:<id>[:<facet>]`. `CACHE_KEYS.retailOrder(orderId)` follows the same shape (no caller today; reserved for a future read path).

### TTL

| Env var                     | Default (ms) | Role                                                                 |
| --------------------------- | ------------ | -------------------------------------------------------------------- |
| `CACHE_TTL_MS_DEFAULT`      | `60000`      | Global default applied by the Cache module to any unscoped `set()`.  |
| `CACHE_TTL_MS_PRODUCT_STOCK`| `60000`      | TTL applied explicitly when caching a stock query response.          |

TTL is a safety net, not the primary freshness mechanism — explicit invalidation is.

### Invalidation

When `ReserveStockForOrderUseCase` reserves stock for a confirmed order, it inserts ledger rows inside a transaction and — **after the transaction commits** — awaits an invalidation pass for every `(productId, storageId)` pair that was written. The await means the confirm RPC's post-state includes "cache cleared for the mutated products", so the next GET reads the fresh DB row.

Invalidation issues two `delByPrefix` calls per affected `productId` (new + legacy prefixes). Each `delByPrefix` does `SCAN MATCH <prefix>*` and `UNLINK`s every matching key. `UNLINK` (vs `DEL`) frees memory asynchronously on the Redis side, avoiding a blocking O(N) delete on Redis's main thread. Calling invalidation before commit would race with concurrent readers and let them re-populate the cache from uncommitted state.

### Tracing

Each cache call opens an OTel span (`cache.get`, `cache.set`, `cache.del`, `cache.wrap`, `cache.delByPrefix`) with `cache.key`, `cache.hit`, and (for prefix deletes) `cache.keys_unlinked` attributes. Hits and misses are visible in Jaeger end-to-end.

### Graceful degradation

Every cache operation is wrapped in a `try/catch` that logs a `warn` and swallows the error:

- **Read failure** → returns `undefined` (the same contract as a miss); the façade falls through to the DB and the request succeeds.
- **Write failure** → swallowed; the response is still returned to the client.
- **Invalidation failure** → swallowed; the entry remains until its TTL expires.

A Redis outage degrades latency, never correctness — no path throws to the client because the cache is unavailable.

### Inspecting the cache

```bash
# List every cached stock entry across all products
redis-cli --scan --pattern 'ris:inventory:stock:*'

# Read a specific entry
redis-cli GET 'ris:inventory:stock:42:__all__'

# Check remaining TTL (in ms) for a key
redis-cli PTTL 'ris:inventory:stock:42:__all__'

# Manually invalidate every cached entry for a single product
redis-cli --scan --pattern 'ris:inventory:stock:42:*' | xargs -r redis-cli UNLINK
```

See [ADR-002](docs/adr/002-redis-cache-aside-product-stock.md) for the original design and [ADR-016](docs/adr/016-cache-aside-generalized.md) for the generalized key convention + port-based invalidation.
