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
  inventory-microservice/   # Stock management
  retail-microservice/      # Orders
  notification-microservice # Stub (not yet implemented)
libs/
  cache/                    # CachePort + RedisCacheAdapter + @Cacheable + cache-keys registry
  common/                   # Slimmed framework-free utilities (result, exceptions, pagination, types); the cache/correlation/modules subfolders are now shims
  config/                   # ConfigModuleConfiguration wrapper; logger/cache/typeorm config files are shims pointing at the new homes
  contracts/                # Cross-service message and DTO contracts (microservices, retail, inventory)
  database/                 # TypeORM base entity/repository, snake-naming strategy, DatabaseModule
  ddd/                      # Framework-free domain building blocks (Entity, AggregateRoot, ValueObject, DomainEvent, IRepositoryPort)
  inventory/                # Shim re-export of @retail-inventory-system/contracts (removed in task-14)
  messaging/                # RabbitMQ wiring — MessagingModule, MicroserviceClient*Module, MicroserviceClientConfiguration, RabbitmqClientFactory, ROUTING_KEYS, EXCHANGES
  observability/            # Pino LoggerModuleConfig + correlation middleware/decorator/types + OTel tracer.ts shell + TraceContextInterceptor + MetricsModule
  retail/                   # Shim re-export of @retail-inventory-system/contracts (removed in task-14)
migrations/                 # TypeORM migrations + data-source config
```

**Request flow:** HTTP → API Gateway → RabbitMQ (request-response) → Microservice → MySQL

**RabbitMQ queues:** `retail_queue`, `inventory_queue`, `notification_events`

**Message patterns (RPC, defined in libs/contracts/microservices and mirrored as `ROUTING_KEYS` in libs/messaging — wire format is dotted `<service>.<aggregate>.<action>`, see ADR-008):**
- `retail.order.create` — create order (API Gateway → Retail)
- `retail.order.confirm` — confirm order (API Gateway → Retail → Inventory)
- `retail.order.get` — get order by id (API Gateway → Retail)
- `inventory.product-stock.get` — query stock levels (API Gateway → Inventory)
- `inventory.order.confirm` — reserve stock for confirmed order products (Retail → Inventory)

## Service Structure

Each service follows this layout:

```
app/
  api/
    [feature]/
      *.controller.ts          # @MessagePattern / @EventPattern handlers
      *.module.ts
      providers/
        *-[action].service.ts  # One service per action
        index.ts               # Barrel export
  common/
    entities/                  # TypeORM entities for this service
config/
  config-object.ts             # Joi-validated env config
```

The API Gateway uses HTTP controllers that delegate to microservices via `ClientProxy` (injected from `MicroserviceClientRetailModule` / `MicroserviceClientInventoryModule`).

## Shared Libraries

Import via path aliases defined in `tsconfig.json`:
- `@retail-inventory-system/contracts` — cross-service message and DTO contracts (plain TypeScript, no Nest decorators outside of `class-validator`/Swagger metadata on DTOs). Sub-areas: `microservices/` (queue/pattern/client-token/app-name enums, `ICorrelationPayload`), `retail/` (Order DTOs, enums, interfaces), `inventory/` (product-stock DTOs, types, constants).
- `@retail-inventory-system/database` — TypeORM base. Exports `BaseEntity`, `BaseTypeormRepository`, `SnakeNamingStrategy` (re-export of `typeorm-naming-strategies`), and `DatabaseModule.forRoot(entities)` / `DatabaseModule.forFeature(entities)`. App modules call `DatabaseModule.forRoot(entities)` instead of constructing `TypeormModuleConfig` directly.
- `@retail-inventory-system/messaging` — RabbitMQ wiring: `MessagingModule`, per-service `MicroserviceClient{Retail,Inventory}Module`, `MicroserviceClientConfiguration`, `RabbitmqClientFactory`, `ROUTING_KEYS` (dotted routing keys), `EXCHANGES` (reserved exchange names). Re-exports `MicroserviceQueueEnum` / `MicroserviceClientTokenEnum` from contracts.
- `@retail-inventory-system/cache` — Redis cache abstraction: `ICachePort` (the abstraction domain code depends on), `CACHE_PORT` (DI token), `RedisCacheAdapter` (concrete `@nestjs/cache-manager` + `@keyv/redis` implementation), `CacheModule` (Nest module that binds the port to the adapter), `@Cacheable()` decorator, `CACHE_KEYS` registry, plus `CacheHelper` for backwards-compat. ADR-002 cache-aside contract preserved verbatim.
- `@retail-inventory-system/observability` — Pino logger + correlation: `LoggerModuleConfig` (Pino setup with redaction and transport split), `CorrelationMiddleware`, `CorrelationId` decorator, `CORRELATION_ID_HEADER` constant, `ICorrelationPayload` (re-exported from contracts), OTel `tracer.ts` (side-effect import — fill in task-10), `TraceContextInterceptor` (stub — body in task-10), `MetricsModule` (placeholder).
- `@retail-inventory-system/ddd` — framework-free domain building blocks: `Entity<TId>`, `AggregateRoot<TId>` (with `pullDomainEvents()`), `ValueObject<TProps>`, `DomainEvent<TAggregateId>`, `IRepositoryPort<TAggregate, TId>`. **No `@nestjs/*`, no TypeORM imports** — domain code is the consumer.
- `@retail-inventory-system/common` — slimmed to framework-free utilities: `Result<T, E>`, `DomainException`, pagination types, utility types. The `cache/`, `correlation/`, and `modules/` subfolders are now one-release shims pointing at the new lib homes; removed in task-14.
- `@retail-inventory-system/config` — `configModuleConfig` (Joi schema). `LoggerModuleConfig`, `cacheModuleConfig`, and `TypeormModuleConfig` are now shims pointing at `libs/observability`, `libs/cache`, and `DatabaseModule.forRoot()` respectively; all three removed in task-14.
- `@retail-inventory-system/inventory`, `@retail-inventory-system/retail` — one-release shims that re-export `@retail-inventory-system/contracts`. Removed in task-14.

**Forbidden imports.** Domain code (under `apps/*/src/.../domain/` and inside `libs/ddd`) MUST NOT import from `@retail-inventory-system/messaging`, `@retail-inventory-system/cache`, `@retail-inventory-system/observability`, `@retail-inventory-system/database`, or any `@nestjs/*` package. Reach those concerns via ports defined in `libs/ddd` (e.g. `IRepositoryPort`) or app-side ports. The boundary will be enforced via `eslint-plugin-boundaries` in task-12; until then it is by code review.

Forward pointer: `auth` is added in task-06.

## Database

MySQL via TypeORM. Connection string from `DATABASE_URL` env var (docker-compose default: `mysql://retail:retailpass@mysql:3306/retail_db`).

Migration config is in `migrations/config/data-source.ts`. Entities are co-located in each microservice under `app/common/entities/`.

Run `docker-compose up` to start MySQL, RabbitMQ, and Redis locally.

## Architecture migration

The codebase is mid-migration on branch `RIS-25-Architecture-migration` toward a per-module hexagonal layout (ports & adapters) per service.

### Architecture rules location

Architectural rules and target state are defined in [`docs/architecture-migration-plan/parts/recommendation.md`](docs/architecture-migration-plan/parts/recommendation.md) and recorded as ADRs under [`docs/adr/`](docs/adr/). The migration plan (`docs/architecture-migration-plan/`) is the *transition* artefact; ADRs are the durable record. Existing ADRs use 3-digit padding (`001-…`, `008-…`); the next free number is `009`.

### No-Git-ops rule for migration tasks

Sessions executing a `task-NN.md` file from `docs/architecture-migration-plan/tasks/` do **not** run `git add`, `git commit`, `git push`, `git tag`, `git merge`, or any other branch-modifying command. Commits and PRs are the human's job. `.gitignore` may be edited only when a task explicitly creates new classes of file that should not be tracked.

### Carryover-file pattern

Each migration task produces a `_carryover-NN.md` next to it; the next task reads it as its first action and fails fast if the file is missing. Carryovers are deleted with the rest of `tasks/` before merge — anything durable goes in this `CLAUDE.md`, the README, or an ADR.

### Baseline snapshot

`docs/baseline/` is a frozen pre-migration snapshot (configs, coverage report, workspace listing) captured at the start of the migration. Treat it as **read-only** — do not edit any file under it.

## Known Issues

- **Redis cache-aside is wired** for product stock queries (see [ADR-002](docs/adr/002-redis-cache-aside-product-stock.md)). The 17 open audit items from `docs/audits/audit-2026-05-08.md` (cache stampede, schema-version segment, multi-tenant prefix, etc.) are tracked but unresolved; task-11 in the migration revisits them.
- **Notification microservice is a stub** — connects to RabbitMQ but has no handlers or logic. Task-07 in the migration replaces this stub with a real notifier service.
- **No authentication today** — no `@nestjs/jwt`, no `passport`, no guards. Task-06 in the migration builds JWT + RBAC from scratch.
- **No OpenTelemetry / Jaeger** — Pino correlation IDs are the only cross-service trace today. Task-10 wires OTel.
