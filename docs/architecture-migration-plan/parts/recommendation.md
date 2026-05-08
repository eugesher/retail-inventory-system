# Final Recommendation — Hexagonal NestJS Monorepo (TypeORM-native)

> Self-contained instruction document. The current project files are
> **not** modified by this document — it is a target specification.
> Reconciled against the live tree on 2026-05-08; conventions below
> reflect decisions recorded in `tasks/_carryover-01.md`:
>
> - App folder names keep the `-microservice` suffix
>   (`api-gateway`, `retail-microservice`, `inventory-microservice`,
>   `notification-microservice`).
> - Path-alias prefix is `@retail-inventory-system/<name>`.
> - ADRs use 3-digit padding (`docs/adr/NNN-<slug>.md`); next free
>   number is **003**.
> - `libs/auth` is built fresh during the migration in
>   `task-06-build-auth-from-scratch.md` (a separate task —
>   it is not part of `task-04-extract-shared-libs-integration`).
> - `docs/architecture/` is **not** created; the README, `CLAUDE.md`,
>   and `docs/adr/` are the only durable documentation artefacts.

## 1. Pattern: Hexagonal Architecture (Ports & Adapters), per service

**Why this and not the others:**

- It's the **only TypeORM-compatible mature pattern** with a published,
  star-validated reference in the NestJS ecosystem (Brocoders, 4.3k★).
- It lets the project keep TypeORM, MySQL, RabbitMQ, Redis, Pino — no
  rewrite of the stack — while gaining a clean seam for testing, swapping
  adapters, and adding cache-aside / OTel / a real Notification service.
- DDD-tactical patterns (value objects, aggregate roots, domain events) can
  be _layered on selectively_ per service as complexity demands, without
  forcing CQRS or event-sourcing now.
- Awesome Nest Boilerplate / Tony133 are flat — they would lock the project
  into "fat services" and provide no answer to the planned cache and
  notification work.
- Domain-Driven Hexagon and Ultimate Backend are too heavy for a portfolio
  project at this stage and use incompatible persistence layers.

## 2. Recommended final directory structure

```
retail-inventory-system/
├── apps/
│   ├── api-gateway/
│   │   └── src/
│   │       ├── modules/
│   │       │   ├── auth/                          # built in task-06
│   │       │   │   ├── application/
│   │       │   │   │   ├── use-cases/
│   │       │   │   │   │   ├── login.use-case.ts
│   │       │   │   │   │   ├── refresh-token.use-case.ts
│   │       │   │   │   │   └── validate-user.use-case.ts
│   │       │   │   │   └── ports/token.port.ts
│   │       │   │   ├── domain/
│   │       │   │   │   ├── user.model.ts
│   │       │   │   │   └── role.model.ts
│   │       │   │   ├── infrastructure/
│   │       │   │   │   ├── jwt/jwt-token.adapter.ts
│   │       │   │   │   ├── jwt/jwt.strategy.ts
│   │       │   │   │   └── auth.module.ts
│   │       │   │   └── presentation/
│   │       │   │       ├── auth.controller.ts
│   │       │   │       ├── dto/login.request.dto.ts
│   │       │   │       └── dto/token.response.dto.ts
│   │       │   ├── retail/
│   │       │   │   ├── application/
│   │       │   │   │   └── ports/retail-gateway.port.ts
│   │       │   │   ├── infrastructure/
│   │       │   │   │   └── messaging/retail-rabbitmq.adapter.ts
│   │       │   │   └── presentation/
│   │       │   │       ├── order.controller.ts
│   │       │   │       └── dto/
│   │       │   └── inventory/
│   │       │       ├── application/ports/inventory-gateway.port.ts
│   │       │       ├── infrastructure/messaging/inventory-rabbitmq.adapter.ts
│   │       │       └── presentation/product.controller.ts
│   │       ├── app.module.ts
│   │       └── main.ts                           # first import: @retail-inventory-system/observability/tracer
│   ├── retail-microservice/
│   │   └── src/
│   │       ├── modules/
│   │       │   └── orders/
│   │       │       ├── application/
│   │       │       │   ├── use-cases/
│   │       │       │   │   ├── create-order.use-case.ts
│   │       │       │   │   ├── confirm-order.use-case.ts
│   │       │       │   │   └── get-order.use-case.ts
│   │       │       │   ├── ports/
│   │       │       │   │   ├── order.repository.port.ts
│   │       │       │   │   ├── order-events.publisher.port.ts
│   │       │       │   │   └── inventory-confirm.gateway.port.ts
│   │       │       │   └── dto/
│   │       │       │       ├── create-order.command.ts
│   │       │       │       └── order.view.ts
│   │       │       ├── domain/
│   │       │       │   ├── order.model.ts                    # framework-free
│   │       │       │   ├── order-product.model.ts
│   │       │       │   ├── order-status.value-object.ts
│   │       │       │   └── events/
│   │       │       │       ├── order-created.event.ts
│   │       │       │       └── order-confirmed.event.ts
│   │       │       ├── infrastructure/
│   │       │       │   ├── persistence/
│   │       │       │   │   ├── order.entity.ts               # @Entity (TypeORM)
│   │       │       │   │   ├── order.mapper.ts               # entity ↔ domain
│   │       │       │   │   └── order-typeorm.repository.ts
│   │       │       │   ├── messaging/
│   │       │       │   │   ├── order-rabbitmq.publisher.ts
│   │       │       │   │   └── inventory-confirm.rabbitmq.adapter.ts
│   │       │       │   ├── cache/order-redis.cache.ts
│   │       │       │   └── orders.module.ts
│   │       │       └── presentation/
│   │       │           ├── orders.controller.ts              # @MessagePattern
│   │       │           └── dto/
│   │       ├── app.module.ts
│   │       └── main.ts
│   ├── inventory-microservice/
│   │   └── src/
│   │       ├── modules/
│   │       │   └── stock/                                    # mirrors orders shape
│   │       │       ├── application/{use-cases,ports,dto}/
│   │       │       ├── domain/{stock-item.model.ts,events/}
│   │       │       ├── infrastructure/{persistence,messaging,cache}/
│   │       │       └── presentation/stock.controller.ts
│   │       ├── app.module.ts
│   │       └── main.ts
│   └── notification-microservice/
│       └── src/
│           ├── modules/
│           │   └── notifications/
│           │       ├── application/
│           │       │   ├── use-cases/
│           │       │   │   ├── send-order-notification.use-case.ts
│           │       │   │   └── send-low-stock-alert.use-case.ts
│           │       │   └── ports/notifier.port.ts
│           │       ├── domain/notification.model.ts
│           │       ├── infrastructure/
│           │       │   ├── consumers/
│           │       │   │   ├── order-events.consumer.ts
│           │       │   │   └── inventory-events.consumer.ts
│           │       │   ├── delivery/
│           │       │   │   ├── log.notifier.adapter.ts       # default binding
│           │       │   │   ├── email.notifier.adapter.ts     # later
│           │       │   │   └── webhook.notifier.adapter.ts
│           │       │   └── notifications.module.ts
│           │       └── presentation/health.controller.ts
│           ├── app.module.ts
│           └── main.ts
├── libs/
│   ├── contracts/                          # SHARED MESSAGE & DTO CONTRACTS — plain TypeScript
│   │   ├── retail/
│   │   │   ├── order.contract.ts
│   │   │   └── order.dto.ts
│   │   ├── inventory/
│   │   │   ├── stock-reserved.contract.ts
│   │   │   └── low-stock.contract.ts
│   │   ├── notification/
│   │   │   └── notification-requested.contract.ts
│   │   └── index.ts
│   ├── messaging/                          # RABBITMQ TRANSPORT
│   │   ├── messaging.module.ts
│   │   ├── routing-keys.constants.ts        # <service>.<aggregate>.<event>
│   │   ├── exchanges.constants.ts
│   │   └── rabbitmq.client.factory.ts
│   ├── database/                           # TYPEORM BASE
│   │   ├── database.module.ts
│   │   ├── base.entity.ts                  # id, createdAt, updatedAt, deletedAt
│   │   ├── base-typeorm.repository.ts
│   │   ├── snake-naming.strategy.ts        # re-exports typeorm-naming-strategies
│   │   └── transactional.decorator.ts
│   ├── cache/                              # REDIS CACHE-ASIDE
│   │   ├── cache.module.ts
│   │   ├── cache.port.ts
│   │   ├── redis-cache.adapter.ts
│   │   ├── decorators/cacheable.decorator.ts
│   │   └── cache-keys.ts
│   ├── auth/                               # added in task-06 — JWT + RBAC primitives
│   │   ├── auth.module.ts
│   │   ├── jwt.strategy.ts
│   │   ├── roles.guard.ts
│   │   ├── current-user.decorator.ts
│   │   └── public.decorator.ts
│   ├── observability/                      # PINO + OTEL
│   │   ├── tracer.ts                       # imported FIRST in main.ts
│   │   ├── logger.module.ts                # nestjs-pino + redact + traceId/spanId enrichment
│   │   ├── trace-context.interceptor.ts
│   │   ├── http-context.middleware.ts      # correlation ID middleware (relocated)
│   │   └── metrics.module.ts
│   ├── ddd/                                # FRAMEWORK-FREE BUILDING BLOCKS
│   │   ├── aggregate-root.base.ts
│   │   ├── entity.base.ts
│   │   ├── value-object.base.ts
│   │   ├── domain-event.base.ts
│   │   └── repository.port.ts
│   ├── common/                             # SLIMMED — pure framework-free utilities only
│   │   ├── result.ts
│   │   ├── exceptions/
│   │   ├── pagination/
│   │   └── types/
│   └── config/                             # CURRENT CONFIG WRAPPERS — kept as-is
│       ├── config-module.config.ts         # Joi schema
│       ├── logger-module.config.ts
│       ├── typeorm-module.config.ts
│       └── cache-module.config.ts
├── migrations/                             # TypeORM CLI migrations — unchanged
├── docs/
│   ├── adr/                                # 3-digit padding; ADR-001…ADR-NNN
│   │   ├── 001-structured-logging-with-pino.md
│   │   ├── 002-redis-cache-aside-product-stock.md
│   │   ├── 003-record-architecture-decisions.md      # added in task-01
│   │   └── …
│   └── audits/
├── docker-compose.yml
├── docker-compose.observability.yml        # jaeger, otel-collector — added in task-11
├── nest-cli.json
├── tsconfig.json                           # path aliases under @retail-inventory-system/<name>
├── package.json
└── .github/workflows/
    └── ci-cd.yml                           # extended with architecture-lint job in task-13
```

## 3. Module boundary rules (what belongs where)

| Layer                    | Allowed to import from                                                                              | Forbidden                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `domain/`                | `@retail-inventory-system/ddd`, `@retail-inventory-system/common` (types only)                       | `@nestjs/*`, TypeORM, Redis, RabbitMQ, axios — anything I/O |
| `application/use-cases/` | `domain/`, own `ports/`, `@retail-inventory-system/ddd`, `@retail-inventory-system/common`, `@retail-inventory-system/contracts` (types) | Concrete adapters; TypeORM `Repository`; `@MessagePattern`  |
| `application/ports/`     | `domain/` types                                                                                     | Anything from `infrastructure/`                             |
| `infrastructure/`        | All layers; `@retail-inventory-system/{database,messaging,cache}`, TypeORM, Redis client, AMQP      | Importing from another service's `domain/` directly         |
| `presentation/`          | `application/`, `@retail-inventory-system/{contracts,auth}`                                          | TypeORM repositories or Redis client directly               |
| `@retail-inventory-system/contracts` | Plain TypeScript only                                                                  | Nest decorators, ORM types                                  |
| `@retail-inventory-system/ddd`       | Nothing framework-specific                                                             | Nest, TypeORM                                               |

> **Inversion rule:** `infrastructure/persistence/<x>-typeorm.repository.ts`
> _implements_ `application/ports/<x>.repository.port.ts`. Use cases depend on
> the port symbol; the module wires the adapter via Nest DI.
>
> **Cross-service rule:** a file under `apps/X/...` must not import from
> `apps/Y/...`. The only legitimate exception is `test/system-api.e2e-spec.ts`
> (already encoded in `eslint.config.mjs` `no-restricted-imports`).

## 4. Naming conventions

- Files: `kebab-case.kind.ts` — e.g. `create-order.use-case.ts`,
  `order-typeorm.repository.ts`, `order-created.event.ts`,
  `low-stock.contract.ts`.
- Classes: `PascalCase` matching the file kind — `CreateOrderUseCase`,
  `OrderTypeormRepository`, `OrderCreatedEvent`, `LowStockContract`.
- Ports: `*.port.ts` exports an interface (`OrderRepositoryPort`) and a
  string DI symbol (`ORDER_REPOSITORY`).
- DTO suffixes by direction:
  - `*.request.dto.ts` — HTTP/RPC inbound
  - `*.response.dto.ts` — HTTP/RPC outbound
  - `*.command.ts` — application-layer write input
  - `*.query.ts` — application-layer read input
  - `*.view.ts` — application-layer read output (projection)
- Domain events: past-tense, `<aggregate>-<action>.event.ts`.
- TypeORM entities: `*.entity.ts`, **only** under
  `infrastructure/persistence/`. They are never the domain model.
- TypeORM column naming: `snake_case` via `SnakeNamingStrategy` (already
  shared from `@retail-inventory-system/config` today; relocated to
  `@retail-inventory-system/database` in task-04).
- RabbitMQ routing keys: `retail.order.created`, `inventory.stock.reserved`,
  `notification.email.requested` — `<service>.<aggregate>.<event>`. The
  current snake-case enum (`MicroserviceMessagePatternEnum`) is migrated
  to dotted constants in task-04.
- Redis cache keys: `ris:<service>:<aggregate>:<id>` (e.g.
  `ris:retail:order:42`). The existing `stock:<productId>:...` pattern
  remains valid for the existing entries; new entries follow the new
  convention. Bridging is documented in task-12.
- Existing eslint conventions are preserved: interface names start
  with `I` and enum names end with `Enum`
  (`@typescript-eslint/naming-convention`).

## 5. Patterns to avoid

- ❌ Injecting `Repository<XEntity>` directly into a service or use case.
- ❌ Putting `@Entity()` decorators on the domain model.
- ❌ Using a single shared DTO for HTTP, RPC, persistence, and events.
- ❌ Importing `ClientProxy` directly from a controller; go through a
  `*.gateway.port.ts` adapter.
- ❌ `async findById(...).then(cache.set)` scattered everywhere — use a
  `@Cacheable()` decorator from `@retail-inventory-system/cache`.
- ❌ Starting OpenTelemetry inside a `@Module()` — it must be the _first_
  import in `main.ts`.
- ❌ Throwing `HttpException` from `domain/` or `application/`. Domain
  throws domain errors; presentation translates them.
- ❌ Cross-service direct DB reads. All inter-service traffic is RabbitMQ.
- ❌ Mixing wire-protocol contracts (`@retail-inventory-system/contracts`)
  with infrastructure modules — contracts have no Nest or ORM imports.

## 6. Adoption sequence (mapped to the migration task queue)

The recommendation is delivered through the contiguous task queue under
`docs/architecture-migration-plan/tasks/`. Numbers below match the
post-task-01 renumbering recorded in `_carryover-01.md`.

1. **task-02 — Preparation and baseline.** Capture pre-migration baseline,
   install `eslint-plugin-boundaries` (off), record an ADR for the
   migration commitment.
2. **task-03 — Extract shared libs: foundation.** Create
   `@retail-inventory-system/{contracts,database}`; slim
   `@retail-inventory-system/common` down to framework-free utilities.
   Apps recompile against the new lib homes.
3. **task-04 — Extract shared libs: integration.** Add
   `@retail-inventory-system/{messaging,cache,observability,ddd}`. Migrate
   the existing `libs/common/cache` and `libs/common/correlation`
   wiring into the new libs.
4. **task-05 — Align API Gateway to hexagonal layout.** Reshape
   `apps/api-gateway/src/` into per-module
   `application/domain/infrastructure/presentation`. Replace direct
   `ClientProxy.send()` calls with gateway-port + RabbitMQ-adapter pairs.
5. **task-06 — Build auth from scratch.** Add `@nestjs/jwt`,
   `@nestjs/passport`, `passport`, `passport-jwt`. Create
   `@retail-inventory-system/auth` (JWT strategy, roles guard,
   `@CurrentUser()`, `@Public()`, module). Build the gateway's hexagonal
   `auth/` module with login/refresh/validate use cases. Add ADRs for
   the JWT/RBAC decisions, README "Authentication" section, and
   CLAUDE.md update.
6. **task-07 — Build Notification service (greenfield).** Establish the
   canonical per-module template; this becomes the reference for
   tasks 08–10.
7. **task-08 — Align Inventory service.** Per-module hexagonal layout
   for stock; relocate `product-stock-common` into
   `modules/stock/{application,infrastructure}`.
8. **task-09 — Align Retail/orders module.** Per-module layout for
   orders; cross-service confirm flow goes through
   `inventory-confirm.gateway.port.ts`. Retail has no products module
   today — if one is introduced later, that's a new task created at
   that time, not a reserved slot in the migration queue.
9. **task-10 — Add OpenTelemetry + Jaeger.** Bring up
   `docker-compose.observability.yml`; flesh out
   `@retail-inventory-system/observability/tracer`; correlate Pino logs
   with `traceId` / `spanId`.
10. **task-11 — Generalize cache-aside.** Apply `@Cacheable` to remaining
    read paths; centralize cache keys; add invalidation on write paths
    beyond what ADR-002 already covers.
11. **task-12 — Enable architecture lint and CI job.** Switch
    `eslint-plugin-boundaries` rules on; fix violations.
12. **task-13 — Back-fill structural ADRs and write the index.**
13. **task-14 — Cleanup, polish, propose release tag.** Final pass; the
    migration `tasks/` folder and carryover files are deleted on merge.

## 7. Parts of the current project that are already correct — preserve

- `apps/` + `libs/` monorepo with `nest-cli.json`. **Keep.**
- API Gateway as a separate app. **Keep.**
- RabbitMQ as the inter-service bus. **Keep** — wrap in
  `@retail-inventory-system/messaging`.
- TypeORM + MySQL with `SnakeNamingStrategy`. **Keep** — relocate the
  strategy and the data-source factory to
  `@retail-inventory-system/database`. Migrations stay where they are
  (`migrations/` at repo root).
- Pino + correlation IDs (ADR-001). **Keep** — relocate to
  `@retail-inventory-system/observability`.
- Redis cache-aside for product stock (ADR-002). **Keep** — relocate
  the `CacheHelper` registry into `@retail-inventory-system/cache`
  and refactor `ProductStockCommonCacheService` to depend on the new
  `CachePort`.
- Joi-validated config (`libs/config/config-module.config.ts`). **Keep.**
- Yarn 4 (Berry) + Husky + lint-staged + Prettier + ESLint 10. **Keep** —
  extend ESLint with `eslint-plugin-boundaries` in task-13.
- Docker Compose with healthchecks. **Keep** — extend with
  `docker-compose.observability.yml` for Jaeger and the OTel collector.
- GitHub Actions CI (`ci-cd.yml`). **Keep** — add an
  architecture-lint job in task-13.
- `test/system-api.e2e-spec.ts` end-to-end suite. **Keep** — let it
  guard the migration; rewrite assertions only when a contract changes
  intentionally.
