# Final Recommendation — Hexagonal NestJS Monorepo (TypeORM-native)

> Self-contained instruction document. Hand to Claude Code (or to yourself)
> as the migration brief. The current project files are **not** modified by
> this document — it is a target specification.

## 1. Pattern: Hexagonal Architecture (Ports & Adapters), per service

**Why this and not the others:**

- It's the **only TypeORM-compatible mature pattern** with a published,
  star-validated reference in the NestJS ecosystem (Brocoders, 4.3k★).
- It lets the user keep TypeORM, MySQL, RabbitMQ, Redis, Pino, JWT — no
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
│ ├── api-gateway/
│ │ └── src/
│ │ ├── modules/
│ │ │ ├── auth/
│ │ │ │ ├── application/
│ │ │ │ │ ├── use-cases/
│ │ │ │ │ │ ├── login.use-case.ts
│ │ │ │ │ │ └── refresh-token.use-case.ts
│ │ │ │ │ └── ports/
│ │ │ │ │ └── token.port.ts
│ │ │ │ ├── domain/
│ │ │ │ │ ├── user.model.ts
│ │ │ │ │ └── role.model.ts
│ │ │ │ ├── infrastructure/
│ │ │ │ │ ├── jwt/
│ │ │ │ │ │ ├── jwt-token.adapter.ts
│ │ │ │ │ │ └── jwt.strategy.ts
│ │ │ │ │ └── auth.module.ts
│ │ │ │ └── presentation/
│ │ │ │ ├── auth.controller.ts
│ │ │ │ ├── dto/
│ │ │ │ │ ├── login.request.dto.ts
│ │ │ │ │ └── token.response.dto.ts
│ │ │ │ └── guards/
│ │ │ │ ├── jwt-auth.guard.ts
│ │ │ │ └── roles.guard.ts
│ │ │ ├── retail/ # gateway → retail proxy
│ │ │ │ └── presentation/
│ │ │ │ ├── retail.controller.ts
│ │ │ │ └── dto/
│ │ │ └── inventory/ # gateway → inventory proxy
│ │ │ └── presentation/
│ │ ├── app.module.ts
│ │ └── main.ts
│ ├── retail/
│ │ └── src/
│ │ ├── modules/
│ │ │ ├── products/
│ │ │ │ ├── application/
│ │ │ │ │ ├── use-cases/
│ │ │ │ │ │ ├── create-product.use-case.ts
│ │ │ │ │ │ ├── update-product.use-case.ts
│ │ │ │ │ │ ├── find-product.use-case.ts
│ │ │ │ │ │ └── list-products.use-case.ts
│ │ │ │ │ ├── ports/
│ │ │ │ │ │ ├── product.repository.port.ts
│ │ │ │ │ │ └── product-events.publisher.port.ts
│ │ │ │ │ └── dto/
│ │ │ │ │ ├── create-product.command.ts
│ │ │ │ │ ├── update-product.command.ts
│ │ │ │ │ └── product.view.ts
│ │ │ │ ├── domain/
│ │ │ │ │ ├── product.model.ts # framework-free
│ │ │ │ │ ├── price.value-object.ts
│ │ │ │ │ └── events/
│ │ │ │ │ ├── product-created.event.ts
│ │ │ │ │ └── product-updated.event.ts
│ │ │ │ ├── infrastructure/
│ │ │ │ │ ├── persistence/
│ │ │ │ │ │ ├── product.entity.ts # @Entity (TypeORM)
│ │ │ │ │ │ ├── product.mapper.ts # entity ↔ domain
│ │ │ │ │ │ └── product-typeorm.repository.ts
│ │ │ │ │ ├── messaging/
│ │ │ │ │ │ └── product-rabbitmq.publisher.ts
│ │ │ │ │ ├── cache/
│ │ │ │ │ │ └── product-redis.cache.ts
│ │ │ │ │ └── products.module.ts
│ │ │ │ └── presentation/
│ │ │ │ ├── products.controller.ts # @MessagePattern
│ │ │ │ └── dto/
│ │ │ ├── orders/ # same shape
│ │ │ └── ...
│ │ ├── config/
│ │ │ ├── typeorm.config.ts
│ │ │ ├── rabbitmq.config.ts
│ │ │ └── redis.config.ts
│ │ ├── app.module.ts
│ │ └── main.ts
│ ├── inventory/ # same internal shape
│ │ └── src/
│ │ └── modules/{stock,warehouses,reservations}/{application,domain,infrastructure,presentation}
│ └── notification/
│ └── src/
│ └── modules/notifications/
│ ├── application/
│ │ ├── use-cases/
│ │ │ ├── send-order-notification.use-case.ts
│ │ │ └── send-low-stock-alert.use-case.ts
│ │ └── ports/
│ │ └── notifier.port.ts
│ ├── domain/
│ │ └── notification.model.ts
│ ├── infrastructure/
│ │ ├── consumers/ # RabbitMQ subscribers
│ │ │ ├── order-events.consumer.ts
│ │ │ └── inventory-events.consumer.ts
│ │ ├── delivery/
│ │ │ ├── log.notifier.adapter.ts # default no-op-ish
│ │ │ ├── email.notifier.adapter.ts # nodemailer (later)
│ │ │ └── webhook.notifier.adapter.ts
│ │ └── notifications.module.ts
│ └── presentation/ # health/admin only
├── libs/
│ ├── contracts/ # SHARED MESSAGE & DTO CONTRACTS
│ │ └── src/
│ │ ├── retail/
│ │ │ ├── product-created.contract.ts
│ │ │ └── product.dto.ts
│ │ ├── inventory/
│ │ │ ├── stock-reserved.contract.ts
│ │ │ └── low-stock.contract.ts
│ │ ├── notification/
│ │ │ └── notification-requested.contract.ts
│ │ ├── auth/
│ │ │ ├── current-user.dto.ts
│ │ │ └── role.enum.ts
│ │ └── index.ts
│ ├── messaging/ # RABBITMQ TRANSPORT
│ │ └── src/
│ │ ├── messaging.module.ts
│ │ ├── exchanges.constants.ts
│ │ ├── routing-keys.constants.ts
│ │ ├── rabbitmq.client.factory.ts
│ │ └── decorators/
│ │ ├── event-pattern.decorator.ts
│ │ └── message-pattern.decorator.ts
│ ├── database/ # TYPEORM BASE
│ │ └── src/
│ │ ├── database.module.ts
│ │ ├── base.entity.ts # id, createdAt, updatedAt, deletedAt
│ │ ├── base-typeorm.repository.ts
│ │ ├── snake-naming.strategy.ts
│ │ ├── migrations/ # cross-cutting only
│ │ └── transactional.decorator.ts
│ ├── cache/ # REDIS CACHE-ASIDE
│ │ └── src/
│ │ ├── cache.module.ts
│ │ ├── cache.port.ts
│ │ ├── redis-cache.adapter.ts
│ │ ├── decorators/
│ │ │ └── cacheable.decorator.ts
│ │ └── cache-keys.ts
│ ├── auth/ # SHARED AUTH PRIMITIVES
│ │ └── src/
│ │ ├── jwt.strategy.ts
│ │ ├── roles.guard.ts
│ │ ├── current-user.decorator.ts
│ │ ├── public.decorator.ts
│ │ └── auth.module.ts
│ ├── observability/ # PINO + OTEL + JAEGER
│ │ └── src/
│ │ ├── tracer.ts # imported FIRST in main.ts
│ │ ├── logger.module.ts # nestjs-pino + redact
│ │ ├── trace-context.interceptor.ts
│ │ ├── metrics.module.ts
│ │ └── http-context.middleware.ts
│ ├── ddd/ # FRAMEWORK-FREE BUILDING BLOCKS
│ │ └── src/
│ │ ├── aggregate-root.base.ts
│ │ ├── entity.base.ts
│ │ ├── value-object.base.ts
│ │ ├── domain-event.base.ts
│ │ └── repository.port.ts
│ └── common/ # PURE UTILITIES (no Nest deps)
│ └── src/
│ ├── result.ts
│ ├── exceptions/
│ ├── pagination/
│ └── types/
├── docs/
│ ├── adr/
│ │ ├── 0001-record-architecture-decisions.md
│ │ ├── 0002-monorepo-with-apps-and-libs.md
│ │ ├── 0003-hexagonal-architecture-per-service.md
│ │ ├── 0004-typeorm-mysql-as-persistence.md
│ │ ├── 0005-rabbitmq-as-message-bus.md
│ │ ├── 0006-redis-cache-aside.md
│ │ ├── 0007-pino-and-opentelemetry.md
│ │ └── 0008-jwt-rbac-at-the-gateway.md
│ └── architecture/
│ ├── overview.md
│ ├── messaging-contracts.md
│ └── module-template.md
├── docker-compose.yml
├── docker-compose.observability.yml # jaeger, otel-collector
├── nest-cli.json
├── tsconfig.json
├── tsconfig.build.json
├── package.json
└── .github/workflows/
├── ci.yml
└── lint-architecture.yml # eslint-plugin-boundaries

```

## 3. Module boundary rules (what belongs where)

| Layer                    | Allowed to import from                                                             | Forbidden                                                   |
| ------------------------ | ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `domain/`                | `libs/ddd`, `libs/common` (types only)                                             | `@nestjs/*`, TypeORM, Redis, RabbitMQ, axios — anything I/O |
| `application/use-cases/` | `domain/`, own `ports/`, `libs/ddd`, `libs/common`                                 | Concrete adapters; TypeORM `Repository`; `@MessagePattern`  |
| `application/ports/`     | `domain/` types                                                                    | Anything from `infrastructure/`                             |
| `infrastructure/`        | All layers; `libs/database`, `libs/messaging`, `libs/cache`, TypeORM, Redis client | Importing from another service's `domain/` directly         |
| `presentation/`          | `application/`, `libs/auth`, `libs/contracts`                                      | TypeORM repositories or Redis client directly               |
| `libs/contracts`         | Plain TypeScript only                                                              | Nest decorators, ORM types                                  |
| `libs/ddd`               | Nothing framework-specific                                                         | Nest, TypeORM                                               |

> **Inversion rule:** `infrastructure/persistence/<x>-typeorm.repository.ts`
> _implements_ `application/ports/<x>.repository.port.ts`. Use cases depend on
> the port symbol; the module wires the adapter via Nest DI.

## 4. Naming conventions

- Files: `kebab-case.kind.ts` — e.g. `create-product.use-case.ts`,
  `product-typeorm.repository.ts`, `product-created.event.ts`,
  `low-stock.contract.ts`.
- Classes: `PascalCase` matching the file kind — `CreateProductUseCase`,
  `ProductTypeormRepository`, `ProductCreatedEvent`, `LowStockContract`.
- Ports: `*.port.ts` and the symbol is exported as `PRODUCT_REPOSITORY`
  (string token) plus an interface `ProductRepositoryPort`.
- DTO suffixes by direction:
  - `*.request.dto.ts` — HTTP/RPC inbound
  - `*.response.dto.ts` — HTTP/RPC outbound
  - `*.command.ts` — application-layer write input
  - `*.query.ts` — application-layer read input
  - `*.view.ts` — application-layer read output (projection)
- Domain events: past-tense, `<aggregate>-<action>.event.ts`.
- TypeORM entities: `*.entity.ts`, **only** under
  `infrastructure/persistence/`. They are never the domain model.
- TypeORM column naming: `snake_case` via `SnakeNamingStrategy` shared from
  `libs/database`.
- RabbitMQ routing keys: `retail.product.created`, `inventory.stock.reserved`,
  `notification.email.requested` — `<service>.<aggregate>.<event>`.
- Redis cache keys: `ris:<service>:<aggregate>:<id>` (e.g.
  `ris:retail:product:42`).

## 5. Patterns to avoid

- ❌ Injecting `Repository<XEntity>` directly into a service.
- ❌ Putting `@Entity()` decorators on the domain model.
- ❌ Using a single shared DTO for HTTP, RPC, persistence, and events.
- ❌ One mega-`libs/common` for everything — split it.
- ❌ Calling `client.send()` (RabbitMQ) from a controller or a use case
  directly — go through a `*.publisher.port.ts`.
- ❌ `async findById(...).then(cache.set)` scattered everywhere — use a
  `@Cacheable()` decorator from `libs/cache`.
- ❌ Starting OpenTelemetry inside a `@Module()` — it must be the _first_
  import in `main.ts`.
- ❌ Throwing `HttpException` from `domain/` or `application/`. Domain
  throws domain errors; presentation translates them.
- ❌ Cross-service direct DB reads. All inter-service traffic is RabbitMQ.

## 6. Suggested adoption sequence (4 microservices)

1. **`libs/` first.** Split `libs/common` into `libs/contracts`,
   `libs/database`, `libs/messaging`, `libs/cache`, `libs/auth`,
   `libs/observability`, `libs/ddd`. Nothing under `apps/` is touched in this
   phase.
2. **Pick the smallest service first: Notification.** It's a stub, so the
   migration is "build it correctly the first time" rather than "rewrite".
   Establishes the template.
3. **Inventory** next — has the clearest aggregate (Stock) and benefits most
   from the cache port and from emitting `LowStockEvent`.
4. **Retail** — the most feature-dense; migrate per-module
   (Products → Orders → …) so each PR is reviewable.
5. **API Gateway** last — once the contracts are stabilized in
   `libs/contracts`, the gateway becomes a thin presentation/proxy layer that
   imports those contracts and hands off to RabbitMQ.
6. **Cross-cutting upgrades** (after services migrated): cache-aside on read
   paths, OTel/Jaeger compose stack, ADRs, expanded test coverage.

## 7. Parts of the current project that are already correct — preserve

- `apps/` + `libs/` monorepo with `nest-cli.json`. **Keep.**
- API Gateway as a separate app. **Keep.**
- RabbitMQ as the inter-service bus. **Keep** — wrap in `libs/messaging`.
- TypeORM + MySQL. **Keep** — move entities into
  `infrastructure/persistence/`.
- Pino as the logger. **Keep** — relocate to `libs/observability`.
- JWT + RBAC at the gateway. **Keep** — relocate guards/strategies to
  `libs/auth`.
- Docker Compose as the dev orchestration. **Keep** — extend with
  `docker-compose.observability.yml` for Jaeger and the OTel collector.
- GitHub Actions CI. **Keep** — add an architecture-lint job.
