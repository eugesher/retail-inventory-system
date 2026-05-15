# _carryover-01.md — Survey inputs and scaffold the guide

> Generated 2026-05-15 by the task-01 session of the **architecture
> migration guide** writing flow (this is the Russian-language guide
> at `docs/architecture-migration-ru/`, distinct from the migration
> plan at `docs/architecture-migration-plan/`).

## Entry-gate result

```
$ git rev-parse HEAD
84b1507c68fd9ee02b185eef3c4594b6fe02f664

$ yarn install
➤ YN0000: · Yarn 4.12.0
➤ YN0000: ┌ Resolution step
➤ YN0000: └ Completed in 0s 457ms
➤ YN0000: ┌ Fetch step
➤ YN0000: └ Completed in 1s 400ms
➤ YN0000: ┌ Link step
➤ YN0000: └ Completed in 0s 627ms
➤ YN0000: · Done in 2s 786ms

$ yarn build
webpack 5.106.0 compiled successfully in 7419 ms   # api-gateway
webpack 5.106.0 compiled successfully in 8909 ms   # inventory-microservice
webpack 5.106.0 compiled successfully in 9226 ms   # retail-microservice
webpack 5.106.0 compiled successfully in 9847 ms   # notification-microservice
```

`yarn install && yarn build` succeed on the entry SHA. The task is
docs-only and changes no code under `apps/` or `libs/`.

## HEAD SHA for permalinks

```
84b1507c68fd9ee02b185eef3c4594b6fe02f664
```

This is `git rev-parse HEAD` at task-01 entry on branch
`migration-guide`. **Every subsequent task constructs GitHub
permalinks against this SHA**, never against `main` or a branch
name. Format:

```
https://github.com/eugesher/retail-inventory-system/blob/84b1507c68fd9ee02b185eef3c4594b6fe02f664/<path>#L<start>-L<end>
```

If a future task finds this section missing or malformed, it must
mark itself **BLOCKED** rather than guess a SHA.

## Inventory

### Decisions

Every ADR catalogued in `docs/adr/index.md`. The "originating task"
column points at the executed migration-plan task whose
`_carryover-NN.md` records the moment the ADR was first introduced
(not necessarily the moment it was authored — back-fills happened in
phase 13).

| #   | Slug                                              | Status   | Date       | Decision                                                                                              | Originating task                                                                                                          |
| --- | ------------------------------------------------- | -------- | ---------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 001 | structured-logging-with-pino                      | Accepted | —          | Pino + `nestjs-pino` JSON logs; `x-correlation-id` middleware threads request id across services.     | Pre-migration (existed at task-01 entry of the migration plan).                                                            |
| 002 | redis-cache-aside-product-stock                   | Accepted | 2026-05-08 | Cache-aside over Redis for the product-stock aggregation; post-commit invalidation; TTL safety net.   | Pre-migration (existed); cross-linked by task-11.                                                                          |
| 003 | record-architecture-decisions                     | Accepted | 2026-05-08 | Nygard-hybrid format, 3-digit padding, slug rules.                                                    | task-01 (migration plan).                                                                                                  |
| 004 | adopt-hexagonal-architecture-per-service          | Accepted | 2026-05-09 | Per-module `domain/application/infrastructure/presentation` split in every service.                   | task-02 (migration plan).                                                                                                  |
| 005 | split-shared-common-into-bounded-libs             | Accepted | 2026-05-09 | Carves `libs/{contracts,database,ddd,messaging,cache,observability}` out of fat `libs/common`.        | task-03 (migration plan).                                                                                                  |
| 006 | cache-aside-via-libs-cache                        | Accepted | 2026-05-10 | `ICachePort` / `RedisCacheAdapter` / `CACHE_KEYS`; preserves ADR-002 contract.                        | task-04 (migration plan).                                                                                                  |
| 007 | pino-and-opentelemetry                            | Accepted | 2026-05-10 | Co-locates Pino + OTel in `libs/observability`; locks tracer-import-first rule for `main.ts`.         | task-04 (migration plan).                                                                                                  |
| 008 | rabbitmq-via-libs-messaging                       | Accepted | 2026-05-10 | Centralises RMQ wiring; flips routing keys to dotted `<service>.<aggregate>.<action>`.                | task-04 (migration plan).                                                                                                  |
| 009 | port-adapter-at-the-gateway                       | Accepted | 2026-05-10 | Reshapes gateway to per-module hexagonal; `ClientProxy` confined to messaging adapters.               | task-05 (migration plan).                                                                                                  |
| 010 | jwt-rbac-at-the-gateway                           | Accepted | 2026-05-10 | HS256 JWT + rotated refresh w/ reuse-detection + argon2id + global `JwtAuthGuard`/`RolesGuard`.       | task-06 (migration plan).                                                                                                  |
| 011 | notifier-port-and-adapters                        | Accepted | 2026-05-13 | Notification = canonical per-module template; outbound delivery behind `NOTIFIER`.                    | task-07 (migration plan).                                                                                                  |
| 012 | stock-aggregate-and-port-adapter                  | Accepted | 2026-05-13 | Inventory reshaped to single `stock` BC with repository/cache/events-publisher ports.                 | task-08 (migration plan).                                                                                                  |
| 013 | order-aggregate-and-cross-service-confirm         | Accepted | 2026-05-14 | Retail reshaped to single `orders` BC; introduces `INVENTORY_CONFIRM_GATEWAY` RPC seam.               | task-09 (migration plan).                                                                                                  |
| 014 | otel-exporter-otlp-http-and-jaeger                | Accepted | 2026-05-14 | OTLP/HTTP via collector → Jaeger; amqplib hook spans cross-service traces.                            | task-10 (migration plan).                                                                                                  |
| 015 | pino-trace-correlation                            | Accepted | 2026-05-14 | `logMethod` hook injects active-span `traceId`/`spanId` into every Pino record.                       | task-10 (migration plan).                                                                                                  |
| 016 | cache-aside-generalized                           | Accepted | 2026-05-14 | `ris:<service>:<aggregate>:<id>` keys; `delByPrefix`; awaited invalidate post-commit; closes 4 audits. | task-11 (migration plan).                                                                                                  |
| 017 | architecture-lint-via-eslint-boundaries           | Accepted | 2026-05-14 | Layer + lib boundaries as ESLint rules with fixture spec; runs inside `yarn lint`.                    | task-12 (migration plan).                                                                                                  |
| 018 | nestjs-monorepo-apps-and-libs                     | Accepted | 2026-05-14 | NestJS monorepo (`apps/` + `libs/`) recorded as the baseline structure.                               | task-13 (migration plan, back-fill).                                                                                       |
| 019 | typeorm-and-mysql-for-persistence                 | Accepted | 2026-05-14 | TypeORM + MySQL recorded; `mysql2`, `SnakeNamingStrategy`, hand-written migrations.                   | task-13 (migration plan, back-fill).                                                                                       |
| 020 | rabbitmq-as-inter-service-bus                     | Accepted | 2026-05-14 | RabbitMQ as transport for both RPC and events; conventions in ADR-008.                                | task-13 (migration plan, back-fill).                                                                                       |

20 ADRs, all `Accepted`, none `Superseded`. Next free slot is
**ADR-021** (per `CLAUDE.md`).

### Technologies

Stacks the migration adopted or preserved; the version is the one
resolved by `yarn.lock` at the entry SHA (where ranges appear in
`package.json`, they resolve to the listed value via `yarn install`).

| Stack                          | Tool                                          | Version (resolved) | Role                                                                                                |
| ------------------------------ | --------------------------------------------- | ------------------ | --------------------------------------------------------------------------------------------------- |
| Language / TS toolchain        | TypeScript                                    | ^5.9.3             | Source language; compiles per app via `nest build --all`.                                            |
| Framework                      | NestJS                                        | ^11.1.19           | App framework (HTTP + microservices transport).                                                      |
| Monorepo orchestrator          | Nest CLI (`nest-cli.json` `monorepo: true`)   | ^11.0.21           | One repo, four apps, ten path-aliased libs.                                                          |
| Package manager                | Yarn                                          | 4.12.0             | Workspaces over `apps/*` + `libs/*`; lockfile is `yarn.lock`.                                        |
| Build                          | Webpack (via Nest CLI)                        | 5.106.0            | Per-app bundle into `dist/apps/<service>/main.js`.                                                   |
| Persistence                    | TypeORM + `mysql2` + MySQL                    | ^0.3.28 / ^3.20.0 / 8 | `BaseEntity`, `SnakeNamingStrategy`, manual migrations via `yarn migration:*`.                       |
| Messaging                      | RabbitMQ + `amqplib` + `amqp-connection-manager` | n/a / ^0.10.9 / ^5.0.0 | Inter-service bus; RPC (`@MessagePattern`) + events (`@EventPattern`); queues `retail_queue`, `inventory_queue`, `notification_events`. |
| Cache                          | Redis (via `@keyv/redis` → `keyv` → `cache-manager`) | latest containers / ^5.1.6 / ^5.6.0 / ^7.2.8 | Cache-aside via `ICachePort`; SCAN+UNLINK invalidation through `delByPrefix`.                       |
| Auth                           | JWT + Passport + argon2id                     | ^11.0.2 (`@nestjs/jwt`) / ^0.7.0 (`passport`) / ^0.44.0 (`argon2`) | HS256 access + rotated refresh; argon2id password hashes.                                            |
| Observability — logs           | Pino + `nestjs-pino` + `pino-http` + `pino-pretty` (dev) | ^10.3.1 / ^4.6.1 / ^11.0.0 / ^13.1.3 | Structured JSON logs; redacted Authorization/Cookie; `correlationId` thread.                          |
| Observability — traces         | `@opentelemetry/*` (sdk-node, exporter-otlp-http, auto-instrumentations-node, instrumentation-amqplib, core, resources, semantic-conventions, api) | ^0.218.0 / ^0.218.0 / ^0.76.0 / ^0.65.0 / ^2.7.1 / ^2.7.1 / ^1.41.1 / ^1.9.1 | OTLP/HTTP through `otel-collector` to Jaeger; amqplib auto-instrumentation propagates `traceparent`. |
| Validation                     | `class-validator` + `class-transformer`       | ^0.14.4 / ^0.5.1   | DTO validation at HTTP/RPC boundary.                                                                 |
| API docs                       | `@scalar/nestjs-api-reference` + `@nestjs/swagger` | ^1.1.8 / ^11.3.0 | OpenAPI viewer mounted in `main.ts`.                                                                 |
| Config validation              | Joi                                           | ^18.1.1            | Env-schema validation in `libs/config/config-module.config.ts`.                                      |
| Lint / quality                 | ESLint 10 + `typescript-eslint` + `eslint-plugin-boundaries` + Prettier | ^10.1.0 / ^8.57.2 / ^6.0.2 / ^3.8.1 | `yarn lint --max-warnings 0` is the gate; `boundaries/dependencies` v6 rule enforces architecture.   |
| Testing                        | Jest + ts-jest + supertest                    | ^29.7.0 / ^29.3.4 / ^7.0.0 | Unit (`yarn test:unit`) and e2e (`yarn test:e2e` with `test:infra:reload` cycle).                    |
| Local infra                    | Docker Compose                                | n/a                | `docker-compose.yml` (mysql, rabbitmq, redis) + `docker-compose.observability.yml` (jaeger + collector). |
| CI/CD                          | GitHub Actions (`.github/workflows/ci-cd.yml`) | n/a                | lint → build → unit → e2e.                                                                            |

### Libraries

Full `dependencies` + `devDependencies` listing from `package.json`,
grouped by role.

#### Runtime dependencies

| Package                                                  | Version    | Group              | Role                                                                                                  |
| -------------------------------------------------------- | ---------- | ------------------ | ----------------------------------------------------------------------------------------------------- |
| `@nestjs/common`                                         | ^11.1.19   | Framework          | Decorators, modules, pipes.                                                                            |
| `@nestjs/core`                                           | 11.1.19    | Framework          | Module loader, DI container, lifecycle.                                                                |
| `@nestjs/platform-express`                               | ^11.1.19   | Framework — HTTP   | Express adapter used by the gateway.                                                                   |
| `@nestjs/microservices`                                  | ^11.1.19   | Framework — RPC    | RabbitMQ transport (`Transport.RMQ`), `@MessagePattern`, `@EventPattern`.                              |
| `@nestjs/swagger`                                        | ^11.3.0    | Framework — docs   | Decorator-driven OpenAPI metadata; consumed by Scalar viewer.                                          |
| `@nestjs/config`                                         | ^4.0.4     | Framework — config | `ConfigModule.forRoot(configModuleConfig)` Joi schema.                                                 |
| `@nestjs/typeorm`                                        | ^11.0.1    | Framework — DB     | TypeORM Nest integration; provides `Repository<T>` injection used in adapters.                        |
| `@nestjs/cache-manager`                                  | ^3.1.0     | Framework — cache  | Nest wrapper over `cache-manager`. Consumed only inside `libs/cache`.                                  |
| `@nestjs/jwt`                                            | ^11.0.2    | Auth               | `JwtService` for signing access/refresh tokens.                                                        |
| `@nestjs/passport`                                       | ^11.0.5    | Auth               | `PassportStrategy`/`AuthGuard('jwt')` Nest integration.                                                |
| `passport`                                               | ^0.7.0     | Auth               | Underlying middleware that runs the strategy chain.                                                    |
| `passport-jwt`                                           | ^4.0.1     | Auth               | JWT-extraction-and-verify strategy used by `JwtStrategy`.                                              |
| `argon2`                                                 | ^0.44.0    | Auth               | argon2id password hashing (OWASP-2024 defaults).                                                       |
| `typeorm`                                                | ^0.3.28    | Persistence        | ORM; `@Entity`, `Repository<T>`, `DataSource`, migrations.                                             |
| `typeorm-naming-strategies`                              | ^4.1.0     | Persistence        | `SnakeNamingStrategy` re-export.                                                                       |
| `mysql2`                                                 | ^3.20.0    | Persistence        | MySQL driver consumed by TypeORM.                                                                      |
| `amqplib`                                                | ^0.10.9    | Messaging          | Real AMQP client wrapped by `amqp-connection-manager`.                                                 |
| `amqp-connection-manager`                                | ^5.0.0     | Messaging          | Auto-reconnect wrapper used by `@nestjs/microservices` RMQ transport.                                  |
| `cache-manager`                                          | ^7.2.8     | Cache              | get/set/del/wrap façade; the layer `@nestjs/cache-manager` wraps.                                       |
| `keyv`                                                   | ^5.6.0     | Cache              | Storage-adapter abstraction (`KeyvStoreAdapter`).                                                       |
| `@keyv/redis`                                            | ^5.1.6     | Cache              | Concrete Redis client under `keyv`.                                                                    |
| `cacheable`                                              | ^2.3.4     | Cache              | Multi-tier cache primitive; `RedisCacheAdapter` reaches through it for SCAN+UNLINK in `delByPrefix`.    |
| `nestjs-pino`                                            | ^4.6.1     | Observability      | `LoggerModule.forRoot(LoggerModuleConfig)` Nest integration.                                          |
| `pino`                                                   | ^10.3.1    | Observability      | Pino logger underneath `nestjs-pino`.                                                                  |
| `pino-http`                                              | ^11.0.0    | Observability      | HTTP per-request logger middleware.                                                                    |
| `@opentelemetry/api`                                     | ^1.9.1     | Observability      | `trace.getActiveSpan`, `trace.getTracer`. Imported by `logger.module.ts`'s `logMethod` hook.          |
| `@opentelemetry/sdk-node`                                | ^0.218.0   | Observability      | `NodeSDK` driver in `libs/observability/tracer.ts`.                                                    |
| `@opentelemetry/auto-instrumentations-node`              | ^0.76.0    | Observability      | Bundles http/mysql2/redis/amqplib/nestjs-core patches.                                                  |
| `@opentelemetry/instrumentation-amqplib`                 | ^0.65.0    | Observability      | Patch that injects `traceparent` into AMQP properties; makes the four-service trace single-tree.       |
| `@opentelemetry/exporter-trace-otlp-http`                | ^0.218.0   | Observability      | OTLP-over-HTTP exporter to the collector at `:4318/v1/traces`.                                         |
| `@opentelemetry/core`                                    | ^2.7.1     | Observability      | Context manager, propagator. Mostly transitive.                                                        |
| `@opentelemetry/resources`                               | ^2.7.1     | Observability      | `Resource`-builder for `service.name`/`deployment.environment.name`.                                   |
| `@opentelemetry/semantic-conventions`                    | ^1.41.1    | Observability      | String constants for span attributes (avoid `'service.name'` literals).                                |
| `@scalar/nestjs-api-reference`                           | ^1.1.8     | Docs               | Scalar OpenAPI viewer at `/api/reference`.                                                             |
| `class-validator`                                        | ^0.14.4    | Validation         | DTO validation; allowed in `lib-contracts` and `presentation`.                                         |
| `class-transformer`                                      | ^0.5.1     | Validation         | Type-coerce DTO payloads; allowed in `lib-contracts` and `presentation`.                               |
| `joi`                                                    | ^18.1.1    | Config             | Env-schema validation.                                                                                 |
| `express`                                                | ^5.2.1     | Framework — HTTP   | Underlying HTTP framework for the gateway.                                                             |
| `rxjs`                                                   | ^7.8.2     | Framework — reactive | Observable plumbing used by `ClientProxy`; we always wrap with `firstValueFrom` in adapters.          |
| `reflect-metadata`                                       | ^0.2.2     | Framework — DI     | Required by Nest decorators.                                                                           |
| `source-map-support`                                     | ^0.5.21    | Runtime            | Stack-trace remapping.                                                                                 |
| `lodash`                                                 | ^4.17.23   | Utility            | Misc utilities (e.g. `pick`, `omit`).                                                                  |

#### Dev dependencies

| Package                                                  | Version    | Group              | Role                                                                                                  |
| -------------------------------------------------------- | ---------- | ------------------ | ----------------------------------------------------------------------------------------------------- |
| `@nestjs/cli`                                            | ^11.0.21   | Build              | `nest build --all`, `nest start --watch`.                                                              |
| `webpack`                                                | ^5.105.4   | Build              | Bundler invoked by Nest CLI.                                                                           |
| `webpack-node-externals`                                 | ^3.0.0     | Build              | Excludes node_modules from the bundle.                                                                 |
| `terser-webpack-plugin`                                  | ^5.4.0     | Build              | Minifier.                                                                                              |
| `ts-loader`                                              | ^9.5.4     | Build              | TS loader for webpack.                                                                                 |
| `tsconfig-paths-webpack-plugin`                          | ^4.2.0     | Build              | Resolves `@retail-inventory-system/*` aliases in webpack.                                              |
| `typescript`                                             | ^5.9.3     | Build              | Compiler.                                                                                              |
| `ts-node`                                                | ^10.9.2    | Build / scripts    | Runs `migrations/config/data-source.ts` + `scripts/*.ts`.                                              |
| `concurrently`                                           | ^9.2.1     | Dev                | `start:dev` runs four `nest start --watch` processes side-by-side.                                     |
| `dotenv`                                                 | ^17.3.1    | Dev                | `.env.local`/`.env.example` loader.                                                                    |
| `eslint`                                                 | ^10.1.0    | Lint               | Linter; `--max-warnings 0`.                                                                            |
| `@eslint/eslintrc`                                       | ^3.3.5     | Lint               | Legacy-config compatibility for flat config.                                                           |
| `@eslint/js`                                             | ^9.39.4    | Lint               | ESLint's recommended JS preset.                                                                        |
| `typescript-eslint`                                      | ^8.57.2    | Lint               | TS lint meta-package.                                                                                  |
| `@typescript-eslint/parser`                              | ^8.57.2    | Lint               | TS parser.                                                                                             |
| `@typescript-eslint/eslint-plugin`                       | ^8.57.2    | Lint               | TS rules (including the `Enum`-suffix + `I*` interface name conventions).                              |
| `eslint-plugin-boundaries`                               | ^6.0.2     | Lint — architecture | `boundaries/dependencies` v6 rule encodes the layer + lib rules of ADR-017.                            |
| `eslint-plugin-prettier`                                 | ^5.5.5     | Lint               | Surfaces prettier errors as lint errors.                                                               |
| `eslint-config-prettier`                                 | ^10.1.8    | Lint               | Turns off rules that conflict with prettier.                                                           |
| `eslint-import-resolver-typescript`                      | ^4.4.4     | Lint               | Used by `eslint-plugin-boundaries` to resolve TS paths.                                                |
| `prettier`                                               | ^3.8.1     | Format             | `yarn format`.                                                                                         |
| `pino-pretty`                                            | ^13.1.3    | Dev                | Pretty-prints Pino in non-prod.                                                                        |
| `husky`                                                  | ^9.1.7     | Dev — git hooks    | Pre-commit hook runs `lint-staged`.                                                                    |
| `lint-staged`                                            | ^16.4.0    | Dev — git hooks    | Runs `eslint --fix` on staged files.                                                                   |
| `jest`                                                   | ^29.7.0    | Test               | Unit + e2e test runner.                                                                                |
| `ts-jest`                                                | ^29.3.4    | Test               | TS transformer.                                                                                        |
| `@types/jest`                                            | ^29.5.14   | Test types         |                                                                                                       |
| `supertest`                                              | ^7.0.0     | Test               | HTTP assertions in e2e suite.                                                                          |
| `@types/supertest`                                       | ^6.0.2     | Test types         |                                                                                                       |
| `@types/express`                                         | ^5.0.6     | Test types         |                                                                                                       |
| `@types/node`                                            | ^25.5.0    | Test types         |                                                                                                       |
| `@types/amqplib`                                         | ^0         | Types              |                                                                                                       |
| `@types/keyv`                                            | ^4.2.0     | Types              |                                                                                                       |
| `@types/lodash`                                          | ^4.17.24   | Types              |                                                                                                       |
| `@types/passport`                                        | ^0         | Types              |                                                                                                       |
| `@types/passport-jwt`                                    | ^4.0.1     | Types              |                                                                                                       |
| `@types/webpack`                                         | ^5.28.5    | Types              |                                                                                                       |
| `@types/webpack-node-externals`                          | ^3         | Types              |                                                                                                       |

### Migration deltas

One line per executed migration task, sourced from
`docs/architecture-migration-plan/tasks/_carryover-NN.md` (the
receipt of what shipped, not the upstream task script's intent).

| Phase | Task                                                       | Shipped (per carryover)                                                                                                                                                                  |
| ----- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 01    | `task-01-review-project-and-update-plan.md`                 | Reconciled the inherited plan against the live tree; rewrote `parts/project-audit.md`, `recommendation.md`, `migration-checklist.md`; renamed/edited all downstream task drafts; wrote ADR-003. |
| 02    | `task-02-preparation-and-baseline.md`                       | Captured `docs/baseline/` snapshots; installed `eslint-plugin-boundaries@^6.0.2` (not yet wired); wrote ADR-004; minor live infra tweaks for haste/tseslint collisions.                  |
| 03    | `task-03-extract-shared-libs-foundation.md`                 | Created `libs/contracts` + `libs/database`; moved enums/DTOs from `libs/{common,inventory,retail}`; left shims; wrote ADR-005.                                                          |
| 04    | `task-04-extract-shared-libs-integration.md`                | Created `libs/{messaging,cache,observability,ddd}`; flipped routing keys to dotted format; left shims; wrote ADR-006/007/008.                                                          |
| 05    | `task-05-align-api-gateway.md`                              | Gateway moved to per-module hexagonal (`modules/retail/`, `modules/inventory/`); `ClientProxy` confined to messaging adapters; wrote ADR-009.                                          |
| 06    | `task-06-build-auth-from-scratch.md`                        | Built `libs/auth` + gateway `modules/auth/`; JWT (rotated refresh) + argon2id + global guards + seeds; wrote ADR-010.                                                                  |
| 07    | `task-07-build-notification-service.md`                     | Notification microservice built as canonical per-module template; `INotifierPort` + `LogNotifierAdapter`; consumer wiring for `retail.order.created` + `inventory.stock.low`; ADR-011. |
| 08    | `task-08-align-inventory-service.md`                        | Inventory reshaped to `modules/stock/`; repository/cache/events-publisher ports; `inventory.stock.low` producer; ADR-012.                                                              |
| 09    | `task-09-align-retail-orders.md`                            | Retail reshaped to `modules/orders/`; `Order` aggregate folds `OrderConfirmDomain`; `INVENTORY_CONFIRM_GATEWAY` adapter; `retail.order.created/confirmed/cancelled` keys; ADR-013.     |
| 10    | `task-10-add-otel-jaeger-stack.md`                          | Installed 8 `@opentelemetry/*` deps; filled `tracer.ts`; added `docker-compose.observability.yml` + collector config; wrote ADR-014 + ADR-015; first import in every `main.ts`.        |
| 11    | `task-11-add-cache-aside.md`                                | Generalized cache-aside: `ris:<service>:<aggregate>:<id>` keys, `delByPrefix`, awaited invalidate post-commit; renamed `StockRedisCache` → `StockCache`; wrote ADR-016.                |
| 12    | `task-12-enable-architecture-lint.md`                       | Wired `eslint-plugin-boundaries` v6 inside the existing `yarn lint`; added `tests/lint/architecture-lint.spec.ts`; one documented exception `ARCH-LINT-EX-01`; wrote ADR-017.          |
| 13    | `task-13-write-architecture-adrs.md`                        | Back-filled ADR-018/019/020 for structural decisions (monorepo, TypeORM+MySQL, RabbitMQ); created `docs/adr/index.md`; appended cross-reference sections to older ADRs.                |
| 14    | `task-14-cleanup-and-tag.md`                                | Removed all transition shims under `libs/{inventory,retail,common,config}`; dropped the `lib-shim` ESLint element; proposed `v1.0.0-architecture` release tag.                          |

## Final folder structure

The proposed layout from task-01 step 3 survived the inventory check
without edits — every concept/technology/library actually shipped has
a slot, and every proposed slot maps to a real shipping artefact.

```
docs/architecture-migration-ru/
├── architecture-migration-guide.md         ← root: abstract + overview + TOC
├── concepts/
│   ├── hexagonal-architecture.md
│   ├── domain-driven-design.md
│   ├── clean-architecture-layers.md
│   ├── module-boundaries.md
│   └── architecture-decision-records.md
├── project-shape/
│   ├── nestjs-monorepo.md
│   ├── microservices-split.md
│   ├── api-gateway-pattern.md
│   └── shared-libs-philosophy.md
├── persistence/
│   ├── typeorm-overview.md
│   ├── entity-vs-domain-model.md
│   ├── mappers-and-repositories.md
│   ├── base-entity-and-base-repository.md
│   └── snake-naming-strategy.md
├── messaging/
│   ├── rabbitmq-as-bus.md
│   ├── nest-microservices-transport.md
│   ├── message-vs-event-patterns.md
│   └── routing-keys-and-contracts.md
├── caching/
│   ├── cache-aside-pattern.md
│   ├── cache-stack-overview.md
│   ├── lib-nestjs-cache-manager.md
│   ├── lib-cache-manager.md
│   ├── lib-keyv.md
│   ├── lib-keyv-redis.md
│   └── lib-cacheable.md
├── auth/
│   ├── jwt-and-rbac.md
│   ├── auth-stack-overview.md
│   ├── lib-nestjs-passport.md
│   ├── lib-passport.md
│   ├── lib-passport-jwt.md
│   ├── lib-nestjs-jwt.md
│   └── lib-argon2.md
├── observability/
│   ├── opentelemetry-overview.md
│   ├── pino-logging.md
│   ├── trace-log-correlation.md
│   ├── jaeger-backend.md
│   ├── lib-opentelemetry-api.md
│   ├── lib-opentelemetry-sdk-node.md
│   ├── lib-opentelemetry-auto-instrumentations-node.md
│   ├── lib-opentelemetry-instrumentation-amqplib.md
│   ├── lib-opentelemetry-exporter-trace-otlp-http.md
│   ├── lib-opentelemetry-core.md
│   ├── lib-opentelemetry-resources.md
│   └── lib-opentelemetry-semantic-conventions.md
├── application-layer/
│   ├── use-cases-vs-fat-services.md
│   ├── dto-by-direction.md
│   └── notifier-port-and-adapters.md
├── quality/
│   ├── lib-eslint-plugin-boundaries.md
│   └── test-strategy.md
└── glossary.md
```

50 article slots + 1 root file = 51 deliverable `.md` files,
across 9 topic groups + root. Plus `tasks/` (the scratch folder).

## Stub files created

Every article slot exists on disk as a stub carrying frontmatter
(`created: 2026-05-15`, `updated: 2026-05-15`, `status: draft`,
`related: []`) plus the H1 title in Russian and the
`> [!warning] Заглушка — статья ещё не написана` callout.

```
docs/architecture-migration-ru/architecture-migration-guide.md
docs/architecture-migration-ru/concepts/architecture-decision-records.md
docs/architecture-migration-ru/concepts/clean-architecture-layers.md
docs/architecture-migration-ru/concepts/domain-driven-design.md
docs/architecture-migration-ru/concepts/hexagonal-architecture.md
docs/architecture-migration-ru/concepts/module-boundaries.md
docs/architecture-migration-ru/project-shape/api-gateway-pattern.md
docs/architecture-migration-ru/project-shape/microservices-split.md
docs/architecture-migration-ru/project-shape/nestjs-monorepo.md
docs/architecture-migration-ru/project-shape/shared-libs-philosophy.md
docs/architecture-migration-ru/persistence/base-entity-and-base-repository.md
docs/architecture-migration-ru/persistence/entity-vs-domain-model.md
docs/architecture-migration-ru/persistence/mappers-and-repositories.md
docs/architecture-migration-ru/persistence/snake-naming-strategy.md
docs/architecture-migration-ru/persistence/typeorm-overview.md
docs/architecture-migration-ru/messaging/message-vs-event-patterns.md
docs/architecture-migration-ru/messaging/nest-microservices-transport.md
docs/architecture-migration-ru/messaging/rabbitmq-as-bus.md
docs/architecture-migration-ru/messaging/routing-keys-and-contracts.md
docs/architecture-migration-ru/caching/cache-aside-pattern.md
docs/architecture-migration-ru/caching/cache-stack-overview.md
docs/architecture-migration-ru/caching/lib-cacheable.md
docs/architecture-migration-ru/caching/lib-cache-manager.md
docs/architecture-migration-ru/caching/lib-keyv.md
docs/architecture-migration-ru/caching/lib-keyv-redis.md
docs/architecture-migration-ru/caching/lib-nestjs-cache-manager.md
docs/architecture-migration-ru/auth/auth-stack-overview.md
docs/architecture-migration-ru/auth/jwt-and-rbac.md
docs/architecture-migration-ru/auth/lib-argon2.md
docs/architecture-migration-ru/auth/lib-nestjs-jwt.md
docs/architecture-migration-ru/auth/lib-nestjs-passport.md
docs/architecture-migration-ru/auth/lib-passport.md
docs/architecture-migration-ru/auth/lib-passport-jwt.md
docs/architecture-migration-ru/observability/jaeger-backend.md
docs/architecture-migration-ru/observability/lib-opentelemetry-api.md
docs/architecture-migration-ru/observability/lib-opentelemetry-auto-instrumentations-node.md
docs/architecture-migration-ru/observability/lib-opentelemetry-core.md
docs/architecture-migration-ru/observability/lib-opentelemetry-exporter-trace-otlp-http.md
docs/architecture-migration-ru/observability/lib-opentelemetry-instrumentation-amqplib.md
docs/architecture-migration-ru/observability/lib-opentelemetry-resources.md
docs/architecture-migration-ru/observability/lib-opentelemetry-sdk-node.md
docs/architecture-migration-ru/observability/lib-opentelemetry-semantic-conventions.md
docs/architecture-migration-ru/observability/opentelemetry-overview.md
docs/architecture-migration-ru/observability/pino-logging.md
docs/architecture-migration-ru/observability/trace-log-correlation.md
docs/architecture-migration-ru/application-layer/dto-by-direction.md
docs/architecture-migration-ru/application-layer/notifier-port-and-adapters.md
docs/architecture-migration-ru/application-layer/use-cases-vs-fat-services.md
docs/architecture-migration-ru/quality/lib-eslint-plugin-boundaries.md
docs/architecture-migration-ru/quality/test-strategy.md
docs/architecture-migration-ru/glossary.md
```

Total: 51 files (50 stubs + 1 root). Each stub's H1 matches the
intended wiki-link target (kebab-case slug from the filename) so the
TOC wiki-links from the root file resolve immediately.

## Discrepancies

**None.** Every clarification-group library the orchestrator
required is present in `package.json` at the entry SHA:

- **Cache stack** — `@nestjs/cache-manager` ^3.1.0, `cache-manager`
  ^7.2.8, `keyv` ^5.6.0, `@keyv/redis` ^5.1.6, `cacheable` ^2.3.4. ✓
- **Auth stack** — `@nestjs/jwt` ^11.0.2, `@nestjs/passport`
  ^11.0.5, `passport` ^0.7.0, `passport-jwt` ^4.0.1, `argon2`
  ^0.44.0. ✓
- **Observability stack** — `@opentelemetry/api` ^1.9.1,
  `@opentelemetry/auto-instrumentations-node` ^0.76.0,
  `@opentelemetry/core` ^2.7.1,
  `@opentelemetry/exporter-trace-otlp-http` ^0.218.0,
  `@opentelemetry/instrumentation-amqplib` ^0.65.0,
  `@opentelemetry/resources` ^2.7.1,
  `@opentelemetry/sdk-node` ^0.218.0,
  `@opentelemetry/semantic-conventions` ^1.41.1. ✓
- **Quality** — `eslint-plugin-boundaries` ^6.0.2. ✓

Every dedicated `lib-*.md` slot maps to a library that actually
shipped.

## Final task list

The draft set was already well-aligned with the verified folder
structure; granularity ranged from 2 articles (quality) to 8
articles (observability libraries), which fits the 3–8-or-one-large
rule per task. No splits, merges, additions, or deletions were
required. Every `task-NN-…-DRAFT.md` was renamed to drop the
`-DRAFT` suffix and the inline DRAFT preamble was removed.

| NN  | Filename                                                | Topic group               | Article count                                                  |
| --- | ------------------------------------------------------- | ------------------------- | --------------------------------------------------------------- |
| 01  | `task-01-survey-and-scaffold.md`                        | (this task)               | 0 (scaffold-only; 50 stubs + root)                              |
| 02  | `task-02-write-foundational-concepts.md`                | concepts/                 | 5                                                               |
| 03  | `task-03-write-project-shape.md`                        | project-shape/            | 4                                                               |
| 04  | `task-04-write-persistence.md`                          | persistence/              | 5                                                               |
| 05  | `task-05-write-messaging.md`                            | messaging/                | 4                                                               |
| 06  | `task-06-write-caching-stack.md`                        | caching/                  | 7 (1 pattern + 1 overview + 5 lib-*)                            |
| 07  | `task-07-write-auth-stack.md`                           | auth/                     | 7 (1 overview-conceptual + 1 stack overview + 5 lib-*)          |
| 08  | `task-08-write-observability-overview.md`               | observability/ (overviews) | 4                                                               |
| 09  | `task-09-write-observability-libraries.md`              | observability/ (lib-*)    | 8                                                               |
| 10  | `task-10-write-application-layer.md`                    | application-layer/        | 3                                                               |
| 11  | `task-11-write-quality.md`                              | quality/                  | 2                                                               |
| 12  | `task-12-finalize-glossary-and-audit.md`                | glossary + final pass     | 1 (glossary; plus guide-wide audit + `status: final` flip)      |

12 task files total. 50 article slots distributed across tasks
02–12. Task-01 produces only stubs + the root file; it does not
fill any article.

## Notes for downstream tasks

Things the survey turned up that future writers should know.

1. **The HEAD SHA is `84b1507c68fd9ee02b185eef3c4594b6fe02f664`.**
   Every permalink in every article points at this SHA. The branch
   is `migration-guide`. The branch will accumulate writing commits
   from tasks 02–12; do not let any article's permalink reference
   `main` or a branch name, even after merges. If a future task
   notices an article citing a file/range that has since been
   refactored on `migration-guide`, widen the range or pick a
   different excerpt rather than retargeting to a new SHA — the
   SHA pin is what makes the guide reproducible.

2. **The carryover lives forever.** Unlike the migration plan's
   carryovers (deleted by Eugene's post-merge follow-up commit per
   `task-14-cleanup-and-tag.md` §10), this guide's `tasks/` folder
   plus every `_carryover-NN.md` stays in the repository until
   Eugene removes them manually. Do not include any "delete this
   folder before merge" instruction in any task — it does not apply
   here. The same applies to the `DRAFT` files: they were renamed
   in place, not deleted.

3. **The migration-plan carryovers are the authoritative receipts.**
   When a future task needs to know what actually shipped (vs what
   was intended), read
   `docs/architecture-migration-plan/tasks/_carryover-NN.md`, not
   the matching `task-NN-*.md` brief. Especially:
   - `_carryover-08.md` records the inventory split into `modules/stock/`.
   - `_carryover-09.md` records the retail split into `modules/orders/`.
   - `_carryover-10.md` records the OTel wiring + the
     `notification_events`-span-duration artifact.
   - `_carryover-11.md` records the `Cacheable.primary.store`
     dead-path bug and the post-commit-await switch.
   - `_carryover-12.md` records the v6 `boundaries/dependencies`
     migration and the `ARCH-LINT-EX-01` documented exception.

4. **ADR-001 has no `**Date**` line and is intentionally left that
   way** (per `_carryover-13.md` §10). The `concepts/architecture-decision-records.md`
   article should reproduce that nuance (ADR-001 predates ADR-003's
   date convention by one ADR, so it sits "outside" the format that
   ADR-003 codifies) rather than glossing over it.

5. **Three documented exceptions / open audit items remain.** They
   are part of the architecture's honesty, not blemishes to hide:
   - `ARCH-LINT-EX-01` — `EntityManager` typing leaks through
     `IStockRepositoryPort` and `ReserveStockForOrderUseCase`. See
     `apps/inventory-microservice/src/modules/stock/application/ports/stock.repository.port.ts`
     and the inline `eslint-disable-line boundaries/dependencies`
     comment. Closure path: introduce an `ITransactionPort`. The
     `persistence/mappers-and-repositories.md` article must call
     this out.
   - `docs/audits/audit-2026-05-08.md` still has 8 open items
     (`CACHE-001`, `CACHE-002`, `CACHE-003`, `CACHE-004`,
     `CACHE-005`, `CACHE-007`, `CACHE-008`, `CACHE-009`,
     `CODE-001`, `DOCS-001`, `TEST-001`, `TEST-002`, `TEST-003`).
     The `caching/cache-aside-pattern.md` article should enumerate
     them so readers seeing `AUDIT-2026-05-08 [CACHE-N]` markers in
     code understand what is live vs already closed.
   - The notification-consumer span shows a ~62-second duration in
     Jaeger due to how amqplib auto-instrumentation closes consumer
     spans (`_carryover-10.md` §8 #3). Not a real latency. The
     `observability/jaeger-backend.md` article should mention this
     so a reader staring at the Jaeger UI is not misled.

6. **The notification-microservice consumer modules are the canonical
   per-module template** (ADR-011). The other two reshaped
   microservices (`inventory/stock/`, `retail/orders/`) copy that
   shape verbatim. The `application-layer/notifier-port-and-adapters.md`
   article and `project-shape/microservices-split.md` should both
   point at notification as the reference implementation. The
   `apps/notification-microservice/src/modules/notifications/` tree
   is the file-level canonical layout to cite.

7. **The auth module is the only gateway module with a real
   `domain/`** (`_carryover-05.md` §10 #2). When `auth/jwt-and-rbac.md`
   compares to other gateway modules, it should be explicit:
   `modules/retail/` and `modules/inventory/` on the gateway are
   pass-through to messaging adapters; they do not own state.

8. **`ROUTING_KEYS` (in `libs/messaging`) and
   `MicroserviceMessagePatternEnum` (in `libs/contracts/microservices`)
   are kept aligned by a spec** at
   `libs/messaging/spec/routing-keys.constants.spec.ts`. The
   `messaging/routing-keys-and-contracts.md` article should cite
   that spec — it is the lockstep that prevents drift between the
   identifier-name surface and the dotted wire-format surface.

9. **The four observability `main.ts` files must have
   `import '@retail-inventory-system/observability/tracer';` as the
   very first line.** `_carryover-10.md` §8 #1 records that the
   retail microservice was missed at one point and produced no
   spans until fixed. There is no ESLint rule enforcing this today
   (`_carryover-12.md` §13 #3 records the gap). The
   `observability/opentelemetry-overview.md` article should make
   the rule prominent.

10. **The legacy `stock:` cache-key prefix is still alive**
    (`_carryover-11.md` §3, `_carryover-13.md` §9 #3) — it stays
    around through the first post-merge deploy. The
    `caching/cache-aside-pattern.md` article describes only the
    new convention (`ris:<service>:<aggregate>:<id>[:<facet>]`) but
    should explain that the dual-prefix invalidation in
    `StockCache` is a transitional state, not a permanent design.

11. **The `@Cacheable` decorator exists in `libs/cache/decorators/`
    but has no real-world consumer.** `_carryover-11.md` §11 #4
    explains that no current read use case fits its single-call
    read-through shape — `GetStockUseCase` has skip-cache branches
    the decorator cannot express. Worth mentioning in
    `caching/cache-stack-overview.md` as "a slot prepared for
    future list-style read use cases".

12. **Approximate scope.** Across all 50 article slots, the
    expected word count is on the order of 60–90k words total
    (heavier on concept articles, lighter on the per-`lib-*`
    articles). The per-task verification rule is `~600 words`
    soft floor unless explicitly exempted. Adapter-thin library
    articles like `lib-opentelemetry-core` are explicitly allowed
    to sit at the floor.
