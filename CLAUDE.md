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
  common/                   # Slimmed framework-free utilities (result, exceptions, pagination, types) plus shims for things deferred to task-04
  config/                   # ConfigModuleConfiguration wrapper (kept "as-is")
  contracts/                # Cross-service message and DTO contracts (microservices, retail, inventory)
  database/                 # TypeORM base entity/repository, snake-naming strategy, DatabaseModule
  inventory/                # Shim re-export of @retail-inventory-system/contracts (removed in task-14)
  retail/                   # Shim re-export of @retail-inventory-system/contracts (removed in task-14)
migrations/                 # TypeORM migrations + data-source config
```

**Request flow:** HTTP → API Gateway → RabbitMQ (request-response) → Microservice → MySQL

**RabbitMQ queues:** `retail_queue`, `inventory_queue`, `notification_events`

**Message patterns (RPC, defined in libs/contracts/microservices):**
- `RETAIL_ORDER_CREATE` — create order (API Gateway → Retail)
- `RETAIL_ORDER_CONFIRM` — confirm order (API Gateway → Retail → Inventory)
- `RETAIL_ORDER_GET` — get order by id (API Gateway → Retail)
- `INVENTORY_PRODUCT_STOCK_GET` — query stock levels (API Gateway → Inventory)
- `INVENTORY_ORDER_CONFIRM` — reserve stock for confirmed order products (Retail → Inventory)

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
- `@retail-inventory-system/contracts` — cross-service message and DTO contracts (plain TypeScript, no Nest decorators outside of `class-validator`/Swagger metadata on DTOs). Sub-areas: `microservices/` (queue/pattern/client-token/app-name enums), `retail/` (Order DTOs, enums, interfaces), `inventory/` (product-stock DTOs, types, constants).
- `@retail-inventory-system/database` — TypeORM base. Exports `BaseEntity`, `BaseTypeormRepository`, `SnakeNamingStrategy` (re-export of `typeorm-naming-strategies`), and `DatabaseModule.forRoot(entities)` / `DatabaseModule.forFeature(entities)`. App modules call `DatabaseModule.forRoot(entities)` instead of constructing `TypeormModuleConfig` directly.
- `@retail-inventory-system/common` — slimmed to framework-free utilities: `Result<T, E>`, `DomainException`, pagination types, utility types. Currently also still hosts `cache/`, `correlation/`, and the `MicroserviceClient*Module` modules; those move out to `libs/cache`, `libs/observability`, and `libs/messaging` in task-04.
- `@retail-inventory-system/config` — `configModuleConfig` (Joi schema), `LoggerModuleConfig`, `cacheModuleConfig`, plus a deprecated `TypeormModuleConfig` shim (use `DatabaseModule.forRoot()` instead — shim removed in task-14).
- `@retail-inventory-system/inventory`, `@retail-inventory-system/retail` — one-release shims that re-export `@retail-inventory-system/contracts`. Removed in task-14.

Forward pointer: `messaging`, `cache`, `observability`, and `ddd` libraries are added in task-04. `auth` is added in task-06.

## Database

MySQL via TypeORM. Connection string from `DATABASE_URL` env var (docker-compose default: `mysql://retail:retailpass@mysql:3306/retail_db`).

Migration config is in `migrations/config/data-source.ts`. Entities are co-located in each microservice under `app/common/entities/`.

Run `docker-compose up` to start MySQL, RabbitMQ, and Redis locally.

## Architecture migration

The codebase is mid-migration on branch `RIS-25-Architecture-migration` toward a per-module hexagonal layout (ports & adapters) per service.

### Architecture rules location

Architectural rules and target state are defined in [`docs/architecture-migration-plan/parts/recommendation.md`](docs/architecture-migration-plan/parts/recommendation.md) and recorded as ADRs under [`docs/adr/`](docs/adr/). The migration plan (`docs/architecture-migration-plan/`) is the *transition* artefact; ADRs are the durable record. Existing ADRs use 3-digit padding (`001-…`, `005-…`); the next free number is `006`.

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
