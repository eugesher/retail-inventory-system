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
│  RETAIL_ORDER_CREATE   │  │  INVENTORY_PRODUCT_STOCK_GET  │
│  RETAIL_ORDER_CONFIRM  │  │                               │
│                        │  │  Listens:                     │
│  Emits:                │  │  RETAIL_ORDER_CREATED         │
│  RETAIL_ORDER_CREATED ─┼───► (stock reservation)          │
└──────────────┬─────────┘  └─────────────────┬─────────────┘
               │                              │
               │            MySQL             │
               └──────────────┬───────────────┘
                              │
┌─────────────────────────────▼─────────────────────────────┐
│                         Retail DB                         │
│                                                           │
│  order                                                    │
│  order_product                                            │
│  product_stock                                            │
└───────────────────────────────────────────────────────────┘
```

## Shared libraries

Path-aliased TypeScript libraries under `libs/`, imported as `@retail-inventory-system/<name>`:

| Library | Purpose |
| ------- | ------- |
| `contracts` | Cross-service message and DTO contracts (plain TypeScript). Sub-areas: `microservices/` (queue/pattern/client-token/app-name enums, `ICorrelationPayload`), `retail/`, `inventory/`. |
| `database` | TypeORM base — `BaseEntity`, `BaseTypeormRepository`, `SnakeNamingStrategy`, and `DatabaseModule.forRoot(entities)` / `DatabaseModule.forFeature(entities)`. |
| `messaging` | RabbitMQ wiring — `MessagingModule`, per-service `MicroserviceClient{Retail,Inventory}Module`, `MicroserviceClientConfiguration`, `RabbitmqClientFactory`, `ROUTING_KEYS` and `EXCHANGES` constants. |
| `cache` | Cache port + Redis adapter — `ICachePort`, `RedisCacheAdapter`, `CacheModule`, `@Cacheable()` decorator, `CACHE_KEYS` registry. Existing `CacheHelper` is re-exported here for compatibility. |
| `observability` | Pino logger + correlation-ID middleware/decorator/types, OTel `tracer.ts` shell (filled in task-10), `MetricsModule` placeholder, `TraceContextInterceptor` stub. |
| `ddd` | Framework-free domain building blocks — `Entity`, `AggregateRoot`, `ValueObject`, `DomainEvent`, `IRepositoryPort`. No `@nestjs/*` or TypeORM imports. |
| `common` | Slimmed framework-free utilities (`Result`, `DomainException`, pagination types, utility types). The `cache/`, `correlation/`, and `modules/` subfolders are now one-release shims pointing at `libs/{cache,observability,messaging}`. Removed in task-14. |
| `config` | `configModuleConfig` (Joi env schema). `LoggerModuleConfig` and `cacheModuleConfig` are now shims pointing at `libs/observability` and `libs/cache` respectively; `TypeormModuleConfig` is also a shim — use `DatabaseModule.forRoot()` instead. All three shims are removed in task-14. |
| `inventory`, `retail` | One-release shims that re-export `@retail-inventory-system/contracts`. Removed in task-14. |

Forward pointer: `auth` is added in task-06 of the architecture migration.

## Services

| Service                     | Transport                       | Responsibility                                       |
| --------------------------- | ------------------------------- | ---------------------------------------------------- |
| `api-gateway`               | HTTP (port 3000)                | Single entry point; routes requests to microservices |
| `retail-microservice`       | RabbitMQ (`retail_queue`)       | Order creation and confirmation                      |
| `inventory-microservice`    | RabbitMQ (`inventory_queue`)    | Stock queries and reservation                        |
| `notification-microservice` | RabbitMQ (`notification_queue`) | Stub (not yet implemented)                           |

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

Interactive API reference is available at `http://localhost:3000/api/reference` when the gateway is running.

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
{"level":30,"time":1748000000025,"app":"inventory-microservice","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"ProductStockOrderConfirmService","totalProducts":2,"pendingCount":2,"msg":"Received RPC: reserve order product stock"}
{"level":30,"time":1748000000040,"app":"inventory-microservice","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"ProductStockOrderConfirmService","confirmedCount":2,"skippedCount":0,"msg":"Stock reserved for order products"}
{"level":30,"time":1748000000045,"app":"retail-microservice","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"OrderConfirmService","orderId":1,"confirmedCount":2,"msg":"Inventory stock confirmation received"}
{"level":30,"time":1748000000048,"app":"retail-microservice","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"OrderConfirmService","orderId":1,"msg":"Order fully confirmed"}
{"level":30,"time":1748000000060,"app":"api-gateway","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","context":"OrderConfirmService","orderId":1,"statusId":"confirmed","msg":"Order successfully confirmed"}
{"level":30,"time":1748000000070,"app":"api-gateway","correlationId":"a1b2c3d4-e5f6-7890-abcd-ef1234567890","res":{"statusCode":200},"responseTime":60,"msg":"request completed"}
```

See [ADR-001](docs/adr/001-structured-logging-with-pino.md) for the rationale behind this design.

## Caching

The product stock query (`GET /product/:productId/stock`) reads from an append-only `product_stock` ledger. Each row records a delta (positive or negative) against a `(productId, storageId)` pair, so producing a current balance requires a `SUM(quantity) ... GROUP BY storageId` aggregation. Aggregation cost grows linearly with the row count, while the read pattern is heavy and the write pattern is comparatively light — a good fit for caching.

The Inventory microservice caches stock query responses in Redis using the **cache-aside (lazy loading)** pattern. Cache logic lives in `ProductStockCommonService` (façade) and `ProductStockCommonCacheService` (Redis I/O); the HTTP-facing `ProductStockGetService` is unaware of the cache.

### Read flow

```
1. Client request                → ProductStockCommonService.get()
2. cache.get(key)                → hit?  return cached DTO, done
                                 → miss? continue
3. ProductStockCommonGetService  → SUM/GROUP BY against product_stock
4. cache.set(key, data, TTL)     → populate cache
5. Return DTO                    → reply to client
```

Reads inside a caller-owned `EntityManager` (i.e., inside an open transaction) bypass the cache to avoid persisting uncommitted state.

### Cache key

```
stock:<productId>:<storageIds-joined-by-comma>   # e.g. stock:42:storage-a,storage-b
stock:<productId>:*                              # when no storageIds filter is supplied
```

Built by `CacheHelper.keys.productStock(productId, storageIds)` in `libs/common/cache/cache.helper.ts`.

### TTL

| Env var                     | Default (ms) | Role                                                                 |
| --------------------------- | ------------ | -------------------------------------------------------------------- |
| `CACHE_TTL_MS_DEFAULT`      | `60000`      | Global default applied by the Cache module to any unscoped `set()`.  |
| `CACHE_TTL_MS_PRODUCT_STOCK`| `60000`      | TTL applied explicitly when caching a stock query response.          |

TTL is a safety net, not the primary freshness mechanism — explicit invalidation is.

### Invalidation

When `ProductStockOrderConfirmService` reserves stock for a confirmed order, it inserts ledger rows inside a transaction and — **after the transaction commits** — fires a fire-and-forget invalidation for every `(productId, storageId)` pair that was written.

Invalidation runs `SCAN MATCH stock:<productId>:*` per affected `productId` in parallel and `UNLINK`s every matching key. `UNLINK` (vs `DEL`) frees memory asynchronously on the Redis side, avoiding a blocking O(N) delete on Redis's main thread. Calling invalidation before commit would race with concurrent readers and let them re-populate the cache from uncommitted state.

### Graceful degradation

Every cache operation is wrapped in a `try/catch` that logs a `warn` and swallows the error:

- **Read failure** → returns `undefined` (the same contract as a miss); the façade falls through to the DB and the request succeeds.
- **Write failure** → swallowed; the response is still returned to the client.
- **Invalidation failure** → swallowed; the entry remains until its TTL expires.

A Redis outage degrades latency, never correctness — no path throws to the client because the cache is unavailable.

### Inspecting the cache

```bash
# List every cached stock entry across all products
redis-cli --scan --pattern 'stock:*'

# Read a specific entry (replace 42 and the storage list with real values)
redis-cli GET 'stock:42:*'

# Check remaining TTL (in ms) for a key
redis-cli PTTL 'stock:42:*'

# Manually invalidate every cached entry for a single product
redis-cli --scan --pattern 'stock:42:*' | xargs -r redis-cli UNLINK
```

See [ADR-002](docs/adr/002-redis-cache-aside-product-stock.md) for the rationale behind this design.
