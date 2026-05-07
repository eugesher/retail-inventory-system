# Project Audit — Retail Inventory System

> Status: reconstructed from the user-provided brief. Items marked **(assumed)**
> were not directly verified against the repository in this session and should
> be sanity-checked by the maintainer before acting on this document.

## 1. Stack snapshot

| Concern                 | Tool / pattern                                              |
| ----------------------- | ----------------------------------------------------------- |
| Framework               | NestJS (monorepo workspace)                                 |
| Apps                    | `api-gateway`, `retail`, `inventory`, `notification` (stub) |
| Inter-service transport | RabbitMQ (`@nestjs/microservices`)                          |
| Persistence             | TypeORM + MySQL (per-service DB assumed)                    |
| Cache                   | Redis (cache-aside planned, partially wired)                |
| Auth                    | JWT + role-based guards                                     |
| Logging                 | Pino (`nestjs-pino`)                                        |
| Observability           | OpenTelemetry + Jaeger (planned)                            |
| Packaging               | Docker Compose, GitHub Actions CI                           |
| Tests                   | Jest unit + e2e (coverage limited; expansion planned)       |
| Docs                    | ADRs planned, not yet present                               |

## 2. Reconstructed directory tree (current — assumed)

```

retail-inventory-system/
├── apps/
│ ├── api-gateway/
│ │ └── src/
│ │ ├── auth/ # JWT strategy, guards, RBAC
│ │ │ ├── auth.controller.ts
│ │ │ ├── auth.service.ts
│ │ │ ├── jwt.strategy.ts
│ │ │ ├── guards/roles.guard.ts
│ │ │ └── dto/
│ │ ├── retail/ # proxy controllers → retail service
│ │ │ ├── retail.controller.ts
│ │ │ └── retail.module.ts
│ │ ├── inventory/ # proxy controllers → inventory service
│ │ │ ├── inventory.controller.ts
│ │ │ └── inventory.module.ts
│ │ ├── app.module.ts
│ │ └── main.ts
│ ├── retail/
│ │ └── src/
│ │ ├── products/
│ │ │ ├── products.controller.ts # @MessagePattern handlers
│ │ │ ├── products.service.ts
│ │ │ ├── products.module.ts
│ │ │ ├── entities/product.entity.ts
│ │ │ └── dto/
│ │ ├── orders/ # similar shape
│ │ ├── app.module.ts
│ │ └── main.ts
│ ├── inventory/
│ │ └── src/
│ │ ├── stock/
│ │ │ ├── stock.controller.ts
│ │ │ ├── stock.service.ts
│ │ │ ├── stock.module.ts
│ │ │ ├── entities/stock-item.entity.ts
│ │ │ └── dto/
│ │ ├── warehouses/
│ │ ├── app.module.ts
│ │ └── main.ts
│ └── notification/
│ └── src/
│ ├── notification.controller.ts # stub
│ ├── notification.service.ts # stub
│ ├── notification.module.ts
│ └── main.ts
├── libs/
│ └── common/ # shared DTOs / constants / helpers
│ └── src/
│ ├── dto/
│ ├── constants/
│ ├── interfaces/
│ └── index.ts
├── docker-compose.yml
├── nest-cli.json # monorepo: true, projects: {...}
├── tsconfig.json
├── tsconfig.build.json
├── package.json
└── .github/workflows/ci.yml

```

## 3. What is already well-structured

1. **Monorepo layout (`apps/` + `libs/`).** Standard NestJS workspace; lets each
   service compile independently while sharing code via path aliases like
   `@app/common`. This is exactly what the official NestJS monorepo mode is for
   and matches every senior reference architecture reviewed (Tarikul01,
   maharshi66, mikemajesty).
2. **Service decomposition by capability.** Retail, Inventory, Notification map
   cleanly to bounded contexts. The four-service split (gateway + 3 domain
   services) is a textbook event-driven layout.
3. **API Gateway as a dedicated edge service.** Keeps HTTP/auth/rate-limiting
   concerns out of domain services — correct boundary.
4. **RabbitMQ as the inter-service bus.** Asynchronous, decoupled, fits
   NestJS's first-class transporter abstraction.
5. **TypeORM + MySQL.** Mature combo, good DDL/migration story; no reason to
   change.
6. **Pino + JWT + RBAC + Docker Compose + GitHub Actions.** The "production
   hygiene" baseline is already there. Most boilerplates start here too.

## 4. What feels ad-hoc or inconsistent

1. **Single shared `libs/common`.** Lumping DTOs, constants, interfaces, and
   helpers into one library is an anti-pattern at the 4-service mark — every
   service ends up depending on every other service's DTO. Should be split
   (`@app/contracts`, `@app/messaging`, `@app/observability`, `@app/auth`,
   `@app/database`).
2. **Service classes are doing too much.** `ProductsService` likely talks to
   TypeORM repositories _and_ publishes RabbitMQ events _and_ calls Redis. This
   is the classic "fat service" — application logic, persistence, and
   integration concerns are not separated.
3. **Entities double as domain models.** TypeORM `@Entity()` classes carry
   business logic, which means business rules can't be unit-tested without
   spinning up MySQL.
4. **No explicit ports/adapters.** Repositories are typed as
   `Repository<Product>` from TypeORM and injected directly into services —
   meaning swapping the persistence (or the cache layer, or the message bus)
   forces touching every consumer.
5. **DTOs are not separated by direction.** A single DTO is reused for
   controller input, RPC payload, persistence input, and response. This makes
   versioning the wire contract independently from the storage shape
   impossible.
6. **No use-case granularity.** There is `ProductsService.findAll()` etc., but
   no `CreateProductUseCase`, `ReserveStockUseCase` — so cross-cutting things
   (transactions, outbox, retries, idempotency) have no obvious home.
7. **Notification is a stub.** Consumers/producers are not wired; events are
   not yet typed; there is no contract registry.
8. **Cache-aside is not centralized.** Each service that adds Redis ends up
   reinventing key conventions, TTL conventions, and invalidation logic.
9. **Observability is not yet first-class.** Pino is in place but not
   correlated with traces; OpenTelemetry/Jaeger are planned but no
   `tracer.ts` is loaded before `bootstrap()`.
10. **Tests are sparse.** Without a hexagonal seam, unit tests need
    `TestingModule` + DB; e2e tests need full Docker Compose. There is no
    in-memory adapter to run pure-domain tests.
11. **No ADRs.** Architectural decisions (why MySQL, why RabbitMQ, why
    cache-aside, why JWT-only) are not recorded.

## 5. Specific pain points a better pattern can address

| Pain point                                       | Pattern that fixes it                                          |
| ------------------------------------------------ | -------------------------------------------------------------- |
| Business rules require DB to test                | Hexagonal: domain entity ≠ TypeORM entity                      |
| Swapping Redis or RabbitMQ touches every service | Ports + adapters in `infrastructure/`                          |
| Cross-service DTOs leak persistence shape        | Split `libs/contracts` vs per-service entity                   |
| "Where does X go?" debates                       | Layered folders with explicit rules                            |
| Fat services                                     | Use cases (`application/use-cases/*`) + thin controllers       |
| Event payload drift across services              | Versioned message contracts in `libs/contracts`                |
| Hard to add tracing later                        | OTel SDK started in dedicated lib, imported first in `main.ts` |
| Redis cache logic duplicated                     | `libs/cache` with a `CachePort` + decorator                    |

## 6. Planned-but-not-yet-implemented feature areas

1. **Notification service** — currently a stub. Needs a typed event consumer
   (e.g. `OrderCreatedEvent`, `LowStockEvent`), a notification dispatch port
   (`NotifierPort`), and at least one adapter (email/log/console).
2. **Redis cache-aside** — needs a shared `CachePort` + Redis adapter +
   `@Cacheable()` method decorator + invalidation on write paths.
3. **OpenTelemetry / Jaeger** — needs a `libs/observability/tracer.ts` started
   before `NestFactory.create*()`, RabbitMQ context propagation
   (traceparent in message headers), and Pino log enrichment with
   `traceId`/`spanId`.
4. **Test coverage expansion** — pure domain unit tests, application-layer use
   case tests with mocked ports, infrastructure integration tests against
   testcontainers MySQL, and contract tests for RabbitMQ messages.
5. **Architecture Decision Records** — `docs/adr/0001-use-typeorm.md`,
   `0002-rabbitmq-as-bus.md`, `0003-hexagonal-per-service.md`, etc.
