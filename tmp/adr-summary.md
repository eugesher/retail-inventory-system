# ADR Digest — Architectural Decisions of Record

This file is the task-executor's digest of every accepted ADR governing the
retail-inventory-system. **Any Claude Code task executor MUST read this file
before working on the codebase.** For any decision relevant to the task at
hand, open the linked original ADR before implementing — the digest below
summarizes the rules but elides the rationale, alternatives, and edge cases
that the original records. Architectural rules are authoritative; the
in-repo `eslint-plugin-boundaries` setup (ADR-017) enforces a subset and
will fail CI if violated.

---

## ADR-001 — Structured Logging with Pino and Correlation IDs

Status: Accepted. [ADR-001](../docs/adr/001-structured-logging-with-pino.md)

- **Decision:** Use Pino via `nestjs-pino` for JSON structured logs across every service; an `x-correlation-id` HTTP middleware at the gateway threads a UUID through every log line and every outbound RabbitMQ payload.
- **Binding rules for implementers:**
  - All log output is JSON; never reach for `console.*` or the default Nest `ConsoleLogger`.
  - Inside an HTTP request scope the gateway uses `PinoLogger.assign({ correlationId })`; **inside `@EventPattern` / `@MessagePattern` handlers, pass `correlationId` as an inline log field** — `assign()` throws outside request scope (see ADR-011 §7).
  - Every outbound RMQ payload carries `correlationId` (extends `ICorrelationPayload` from `libs/contracts/microservices`).
  - Never log raw `Authorization`, `Cookie`, or `Set-Cookie` headers; redaction is configured centrally.
  - Log level is driven by `LOG_LEVEL` env (`debug` in dev, `info` in prod); don't hard-code levels.

## ADR-002 — Use Redis Cache-Aside for Product Stock Queries

Status: Accepted (2026-05-08). [ADR-002](../docs/adr/002-redis-cache-aside-product-stock.md)

- **Decision:** Stock reads use Redis cache-aside (read-through on miss, write-back, explicit post-commit invalidation, TTL safety net) over the append-only `product_stock` ledger to avoid repeating the `SUM/GROUP BY` aggregation.
- **Binding rules for implementers:**
  - Reads that carry a caller-owned `EntityManager`/`ITransactionScope` or `ignoreCache: true` MUST bypass the cache (would otherwise cache uncommitted state).
  - Invalidation runs **after** commit, never before. (ADR-016 made it `await`-ed; ADR-023 enforces ordering by type — see those entries.)
  - Cache errors are logged at `warn` and swallowed — a Redis outage degrades latency, never correctness.
  - TTL is a safety net only; explicit invalidation is the primary freshness mechanism.

## ADR-003 — Record Architecture Decisions

Status: Accepted (2026-05-08). [ADR-003](../docs/adr/003-record-architecture-decisions.md)

- **Decision:** Significant architectural decisions are recorded as ADRs in `docs/adr/` using the Nygard hybrid layout (Status, Context, Decision, Alternatives Considered, Consequences); files are 3-digit zero-padded with kebab-case slugs naming the decision.
- **Binding rules for implementers:**
  - Filename pattern: `docs/adr/NNN-<short-kebab-slug>.md`; pad the number to 3 digits; the slug names the decision, not the area.
  - Header includes `**Date**` and `**Status**` (`Proposed | Accepted | Superseded by ADR-NNN | Deprecated | Rejected`).
  - Write a new ADR for: choices between reasonable alternatives, codebase-wide constraints, supersessions. Bug fixes and pure refactors don't get ADRs.
  - Never edit a prior ADR in place beyond flipping its `Status` and adding a one-line supersession pointer.
  - Numbers allocated at first commit; do not reserve in advance.

## ADR-004 — Adopt Hexagonal Architecture Per Service

Status: Accepted (2026-05-09). [ADR-004](../docs/adr/004-adopt-hexagonal-architecture-per-service.md)

- **Decision:** Every service in `apps/` uses per-module hexagonal layout: `modules/<name>/{domain,application,infrastructure,presentation}/`.
- **Binding rules for implementers:**
  - `domain/` imports nothing outside its module's domain plus `libs/{ddd,common,contracts}`. No `@nestjs/*`, no `typeorm`, no `class-validator` decorators on entities.
  - `application/` imports `domain/` and injected ports; never imports infrastructure adapters directly.
  - `infrastructure/` is the *only* place that imports TypeORM, RabbitMQ (`@nestjs/microservices`), Redis (`@keyv/redis`, `cache-manager`), or HTTP clients (`axios`).
  - `presentation/` holds controllers (HTTP at the gateway; `@MessagePattern` / `@EventPattern` in microservices); no business logic.
  - Cross-module imports go through `@retail-inventory-system/<lib>` contracts, never deep paths into another module.
  - Naming: interfaces prefixed `I*`; enums suffixed `*Enum`; use cases end `*.use-case.ts`; ports `I<Aggregate>{Port,Repository}` under `application/ports/`; adapters under `infrastructure/<concern>/` ending `*.adapter.ts` / `*.repository.ts`.

## ADR-005 — Split shared `libs/common` into bounded libraries

Status: Accepted (2026-05-09). [ADR-005](../docs/adr/005-split-shared-common-into-bounded-libs.md)

- **Decision:** `libs/common` is split into purpose-named libs (`contracts`, `database`, plus subsequent `messaging`, `cache`, `observability`, `ddd`); `libs/common` is slimmed to framework-free utilities (`Result`, `DomainException`, pagination types).
- **Binding rules for implementers:**
  - Cross-service DTOs / interfaces / enums live in `@retail-inventory-system/contracts` (plain TypeScript; `class-validator` / `@nestjs/swagger` decorators on DTOs are allowed since they *are* the contract).
  - TypeORM base: extend `BaseEntity` from `@retail-inventory-system/database`; wire connections via `DatabaseModule.forRoot(entities)` / `forFeature(entities)` — never construct `TypeOrmModuleOptions` directly in `app.module.ts`.
  - `BaseEntity` uses auto-increment integer PK + `createdAt` / `updatedAt` / nullable `deletedAt`. Soft-delete is via `@DeleteDateColumn`.
  - Migration-window shims in `libs/{common,inventory,retail}` were removed in task-14; do not re-introduce.

## ADR-006 — Cache-aside via `libs/cache` port and adapter

Status: Accepted (2026-05-10). [ADR-006](../docs/adr/006-cache-aside-via-libs-cache.md)

- **Decision:** Introduce `libs/cache` with `ICachePort` (`get`/`set`/`del`/`wrap`), `CACHE_PORT` DI symbol, `RedisCacheAdapter`, `CacheModule`, `CACHE_KEYS` registry, and `@Cacheable` decorator; preserve ADR-002's contract unchanged.
- **Binding rules for implementers:**
  - Application code depends on `ICachePort` / `CACHE_PORT`, never on `@nestjs/cache-manager`, `@keyv/redis`, `cacheable`, or `redis` directly.
  - For domain-shaped caching, define an aggregate-specific port (e.g. `IStockCachePort`) that wraps `ICachePort` and hides key shape from use cases.
  - Use `port.wrap(key, ttl, () => load())` for read-through caching; the call site never branches on hit/miss.

## ADR-007 — Pino structured logs + OpenTelemetry trace correlation

Status: Accepted (2026-05-10). [ADR-007](../docs/adr/007-pino-and-opentelemetry.md)

- **Decision:** Co-locate Pino and OTel in `libs/observability`; **the first executable import in every app's `main.ts` is `@retail-inventory-system/observability/tracer`** so auto-instrumentation patches happen before any HTTP/MySQL/Redis/amqplib module is required.
- **Binding rules for implementers:**
  - Never reorder imports above the `tracer` side-effect import in any `apps/*/src/main.ts`. Auto-formatters that reorder imports must be configured to leave it first.
  - Logs carry both `correlationId` (human-grepable) and `traceId`/`spanId` (auto-injected by ADR-015's logMethod hook). Keep both fields; ADR-001 wins on log shape, ADR-007 wins on trace plumbing.
  - `TraceContextInterceptor` exists as a placeholder — auto-instrumentation covers the cross-service trace today; do not hand-roll span emission unless wrapping a non-instrumented library.

## ADR-008 — RabbitMQ wiring via `libs/messaging` and dotted routing keys

Status: Accepted (2026-05-10). [ADR-008](../docs/adr/008-rabbitmq-via-libs-messaging.md)

- **Decision:** All RabbitMQ wiring lives in `libs/messaging` (`MicroserviceClientConfiguration`, the per-service `MicroserviceClient{Retail,Inventory,Notification}Module`, `MessagingModule`, `RabbitmqClientFactory`, `ROUTING_KEYS`, `EXCHANGES`); routing-key wire format is dotted `<service>.<aggregate>.<action>`.
- **Binding rules for implementers:**
  - New callers reference `ROUTING_KEYS.*` from `@retail-inventory-system/messaging`; the legacy `MicroserviceMessagePatternEnum` exists for back-compat only and must agree value-for-value (asserted by `routing-keys.constants.spec.ts`).
  - Routing-key format is dotted; kebab-case inside tokens for multi-word aggregates (e.g. `inventory.product-stock.get`).
  - The four apps deploy together; any wire-format change for a routing key is one PR that flips every consumer.
  - `EXCHANGES` constants are reserved for future topic-exchange routing; today every queue is bound to the default exchange — don't add per-exchange wiring without a follow-up ADR.

## ADR-009 — Port-and-adapter split at the API gateway

Status: Accepted (2026-05-10). [ADR-009](../docs/adr/009-port-adapter-at-the-gateway.md)

- **Decision:** The API gateway uses per-module hexagonal layout (`modules/{retail,inventory}/{application,infrastructure,presentation}/`); modules are named after the downstream microservice, not the URL prefix; only adapters under `infrastructure/messaging/` hold `ClientProxy`.
- **Binding rules for implementers:**
  - `ClientProxy` (and any `@nestjs/microservices` transport type) is allowed **only** inside `apps/api-gateway/src/modules/*/infrastructure/messaging/*-rabbitmq.adapter.ts`. Controllers, use-cases, and pipes inject the port symbol.
  - Pipes that need pre-controller data (e.g. `OrderConfirmPipe` loading order status) inject the port — never `ClientProxy`.
  - Gateway modules other than `auth` have **no** `domain/` folder — the gateway holds no state of its own apart from the auth module's `User` aggregate (ADR-010).

## ADR-010 — JWT authentication and RBAC at the API gateway

Status: Accepted (2026-05-10). [ADR-010](../docs/adr/010-jwt-rbac-at-the-gateway.md)

- **Decision:** HS256 JWTs (access + refresh, distinct secrets); argon2id for password hashes (OWASP 2024 cost defaults: `memoryCost: 19_456`, `timeCost: 2`, `parallelism: 1`); refresh-token rotation with reuse detection (mismatch clears the live hash); all gateway routes protected by default via global `APP_GUARD`; the `User` aggregate lives in the gateway.
- **Binding rules for implementers:**
  - Every new HTTP route is bearer-token-protected automatically. Opt out *explicitly* on the route with `@Public()` from `@retail-inventory-system/auth` — never via a shared config list.
  - Role-based authorization uses `@Roles(RoleEnum.X, …)`; inject the user with `@CurrentUser()` (returns `ICurrentUser` from `@retail-inventory-system/contracts`).
  - Wire `AuthModule.forRootAsync({ providers: [{ provide: AUTH_USER_VALIDATOR, useClass: ValidateUserUseCase }] })` — the strategy resolves the request user through that port.
  - `JWT_ACCESS_SECRET` and `JWT_REFRESH_SECRET` are required env vars (≥32 chars, distinct). Joi enforces fail-fast at boot.
  - Passwords are always hashed via the argon2 adapter; cost knobs are env-tunable (`AUTH_ARGON2_*`). Never store raw passwords or use bcrypt for new flows.
  - Persist `refresh_token_hash` per user; rotate on every refresh.
  - Public registration is intentionally *not* exposed — `RegisterUserUseCase` exists but is HTTP-unreachable.

## ADR-011 — `NotifierPort` and the notification microservice as the per-module template

Status: Accepted (2026-05-13). [ADR-011](../docs/adr/011-notifier-port-and-adapters.md)

- **Decision:** `apps/notification-microservice/src/modules/notifications/` is the canonical per-module layout that every microservice copies; outbound delivery is behind `INotifierPort` (DI symbol `NOTIFIER`); default binding is `LogNotifierAdapter`; email/webhook adapters are scaffolds today; the microservice is RMQ-only.
- **Binding rules for implementers:**
  - Cross-service events on the wire are plain TypeScript interfaces in `libs/contracts/{retail,inventory}/events/` extending `ICorrelationPayload` + `occurredAt: string` — **never** serialize `DomainEvent<TId>` subclasses across services.
  - RMQ subscribers live under `infrastructure/consumers/`, not `presentation/`; thin adapters that translate wire payloads into use-case calls.
  - Inside `@EventPattern` / `@MessagePattern` handlers, log `correlationId` inline; `PinoLogger.assign()` only works in request scope and will throw.
  - Notification service has no HTTP surface — health check rides RMQ via `notification.health.ping`.

## ADR-012 — Stock aggregate and the inventory port/adapter split

Status: Accepted (2026-05-13). [ADR-012](../docs/adr/012-stock-aggregate-and-port-adapter.md)

- **Decision:** Inventory has one bounded context, `stock`, at `apps/inventory-microservice/src/modules/stock/`. Three ports: `IStockRepositoryPort` (`STOCK_REPOSITORY`), `IStockCachePort` (`STOCK_CACHE`), `IStockEventsPublisherPort` (`STOCK_EVENTS_PUBLISHER`). `StockItem` is a plain class enforcing `quantity ≥ 0`, `reservedQuantity ≥ 0`, `reservedQuantity ≤ quantity`.
- **Binding rules for implementers:**
  - `StockItem` is *not* an `AggregateRoot` — `StockLowEvent` and friends are emitted from the use case after commit, not pulled from the aggregate. Don't add `pullDomainEvents()` calls in stock paths.
  - Low-stock threshold is the constant `INVENTORY_DEFAULT_LOW_STOCK_THRESHOLD` in `libs/contracts/inventory` — don't read it from env or a DB column.
  - TypeORM table/entity names stay `product_stock` / `ProductStock` even though the module is `stock/` — never rename live DB tables out from under data.
  - The legacy `app/api/` and `app/common/` folders are deleted; entities live under `modules/stock/infrastructure/persistence/`.

## ADR-013 — Order aggregate and the cross-service confirm flow

Status: Accepted (2026-05-14). [ADR-013](../docs/adr/013-order-aggregate-and-cross-service-confirm.md)

- **Decision:** Retail has one bounded context, `orders`, at `apps/retail-microservice/src/modules/orders/`. `Order extends AggregateRoot<number | null>`. Three ports: `IOrderRepositoryPort` (`ORDER_REPOSITORY`), `IOrderEventsPublisherPort` (`ORDER_EVENTS_PUBLISHER`), and `IInventoryConfirmGatewayPort` (`INVENTORY_CONFIRM_GATEWAY`) — the seam that lets `ConfirmOrderUseCase` be unit-tested without RabbitMQ.
- **Binding rules for implementers:**
  - The cross-service confirm RPC goes through `INVENTORY_CONFIRM_GATEWAY`, never directly through a `ClientProxy` inside the use case.
  - The wire contract is `IProductStockOrderConfirmPayload` from `@retail-inventory-system/contracts` — both the retail adapter and inventory handler import it, so a drift fails TypeScript on both ends (the contract test).
  - `OrderCreated` event is constructed in `CreateOrderUseCase` *after* repository round-trip assigns the id; `OrderConfirmed` is recorded inside `Order.applyInventoryConfirmation(...)` and drained via `pullDomainEvents()`. Don't fabricate placeholder IDs.
  - Publish failures on post-commit `retail.order.created` are `warn`-logged and swallowed — the order is persisted; notification fan-out is best-effort.
  - No retail-side `cancel` flow today; the aggregate's `cancel()` and the `RETAIL_ORDER_CANCELLED` key surface exist but have no producer or consumer.

## ADR-014 — OTLP/HTTP export to a local Jaeger via an OpenTelemetry collector

Status: Accepted (2026-05-14). [ADR-014](../docs/adr/014-otel-exporter-otlp-http-and-jaeger.md)

- **Decision:** `libs/observability/tracer.ts` uses `@opentelemetry/exporter-trace-otlp-http`; apps publish OTLP/HTTP to a local collector (`docker-compose.observability.yml`) which forwards to Jaeger all-in-one. Auto-instrumentations cover HTTP/MySQL/Redis/amqplib so a single trace spans gateway → retail → inventory → notification.
- **Binding rules for implementers:**
  - Required env vars enforced by Joi at boot: `OTEL_SERVICE_NAME` (distinct per service), `OTEL_EXPORTER_OTLP_ENDPOINT` (must end in `/v1/traces`).
  - Do **not** add manual `@Span()` decorators or `startActiveSpan(...)` calls at the use-case layer — auto-instrumentation already produces controller/handler/TypeORM/Redis/AMQP spans. Hand-rolled spans only for non-instrumented libraries.
  - Local tracing is opt-in: `docker compose -f docker-compose.yml -f docker-compose.observability.yml up`. Don't add Jaeger to the default stack.
  - `OTEL_SDK_DISABLED=true` short-circuits the bootstrap; use it in test contexts that don't want spans.

## ADR-015 — Pino log lines carry OTel `traceId` / `spanId`

Status: Accepted (2026-05-14). [ADR-015](../docs/adr/015-pino-trace-correlation.md)

- **Decision:** `LoggerModuleConfig.pinoHttp.hooks.logMethod` reads `trace.getActiveSpan()?.spanContext()` per log call and merges `{ traceId, spanId }` into the record when the span context is valid; when no span is active, the call passes through cleanly.
- **Binding rules for implementers:**
  - Field names are camelCase (`traceId`, `spanId`), diverging from the OTel snake_case default — keep this consistent with the rest of the project's field naming.
  - Don't manually inject `traceId` into log calls; the hook does it. Boot-time logs (before any span) intentionally omit the fields — don't try to "fix" them.
  - `correlationId` stays alongside `traceId` — they answer different questions (human grep vs Jaeger join). Don't drop `correlationId`.

## ADR-016 — Generalized cache-aside — `ris:<service>:<aggregate>:<id>` keys + port-based invalidation

Status: Accepted (2026-05-14). [ADR-016](../docs/adr/016-cache-aside-generalized.md)

- **Decision:** Cache keys follow `ris:<service>:<aggregate>:<id>[:<facet>]`; `ICachePort` gains `delByPrefix(prefix): Promise<number>`; the only place that reaches through to `KeyvRedis` is `libs/cache/redis-cache.adapter.ts`; `ReserveStockForOrderUseCase` now `await`s the post-commit invalidate.
- **Binding rules for implementers:**
  - Apps under `apps/*/src` MUST NOT write cache-key string literals — every key comes from a `CACHE_KEYS.*` builder in `@retail-inventory-system/cache`. Specs may assert literal strings (they lock in the contract).
  - Apps MUST NOT import `@nestjs/cache-manager`, `@keyv/redis`, or `cacheable` — verification gate: `grep -rE 'redis|cache-manager|keyv' apps/*/src` must return zero matches.
  - Multi-key invalidation uses `CACHE_KEYS.<aggregate>Prefix(...)` + `port.delByPrefix(...)`; await the call post-commit.
  - All-storages sentinel in stock keys is the literal `__all__` (not `*`); the sort comparator on storage IDs is `localeCompare`.

## ADR-017 — Architecture lint via `eslint-plugin-boundaries`

Status: Accepted (2026-05-14). [ADR-017](../docs/adr/017-architecture-lint-via-eslint-boundaries.md)

- **Decision:** `eslint-plugin-boundaries` v6 with `default: 'disallow'` + `checkAllOrigins: true` encodes the per-layer / per-lib import rules from ADR-004 / ADR-005 / ADR-009 etc. Rules run inside the existing `yarn lint` CI gate; `tests/lint/architecture-lint.spec.ts` is the regression fixture suite.
- **Binding rules for implementers:**
  - Don't weaken a rule to make code pass — when in doubt, run `yarn lint` and let it answer where a file belongs. The element-type taxonomy doubles as the code-review vocabulary.
  - Per-layer external denylists (highlights): `domain` denies all `@nestjs/*`, TypeORM, Redis libs, AMQP libs, HTTP clients, Pino; `application-use-case` denies all transport + ORM libs (transactions go through `ITransactionPort`, never raw `EntityManager`); `presentation` denies TypeORM, Redis libs, `@nestjs/typeorm`, AMQP libs (Nest controller/swagger/microservices imports allowed); `lib-contracts` allows `class-validator` / `class-transformer` / `@nestjs/swagger` only.
  - The previous `ARCH-LINT-EX-01` exception (`EntityManager` leak in stock) is **closed** by `ITransactionPort` + `ITransactionScope` (opaque). Don't reintroduce `@InjectEntityManager` or bare `EntityManager` in `application/` — adapters downcast inside `infrastructure/persistence/`.
  - There are no outstanding exceptions; new ones require an ADR.
  - The first-import-is-tracer rule for `apps/*/src/main.ts` is not yet lint-enforced; uphold it manually.

## ADR-018 — NestJS monorepo with `apps/` and `libs/`

Status: Accepted (2026-05-14). [ADR-018](../docs/adr/018-nestjs-monorepo-apps-and-libs.md)

- **Decision:** One Git repository, one root `package.json`, `nest-cli.json` with `"monorepo": true`, deployable services under `apps/<service>/`, shared code under `libs/<name>/` imported as `@retail-inventory-system/<name>` via TypeScript path aliases (not Yarn workspaces).
- **Binding rules for implementers:**
  - Cross-service refactors are one PR; rely on `yarn build` + `yarn lint` + `yarn test:unit` to surface drift across the unified tree.
  - Libraries have no `package.json` of their own — adding workspaces, Nx, or Bazel needs a new ADR.
  - All four apps ship together; no per-service independent release cadence today.
  - New deployable service = a new `apps/<name>/` folder + a `projects` entry in `nest-cli.json` + a per-app `tsconfig.app.json`.

## ADR-019 — TypeORM + MySQL as the persistence stack

Status: Accepted (2026-05-14). [ADR-019](../docs/adr/019-typeorm-and-mysql-for-persistence.md)

- **Decision:** TypeORM (registered via `@nestjs/typeorm`) over MySQL (via `mysql2`) is the persistence stack for every durable-state service. `BaseEntity` from `libs/database` (auto-increment integer `id`, `createdAt`/`updatedAt`/`deletedAt`); `SnakeNamingStrategy`; migrations under `migrations/` applied via TypeORM CLI; `synchronize: true` is **off** in every environment.
- **Binding rules for implementers:**
  - Entities declare fields in camelCase; the naming strategy maps them to `snake_case` columns. Don't write `@Column({ name: '...' })` overrides unless the auto-mapping is genuinely wrong.
  - Schema changes ship as hand-authored migration files (`yarn migration:create` scaffolds; `yarn migration:run` applies). Never use `synchronize: true`.
  - Repository implementations extend `BaseTypeormRepository<TEntity, TDomain>` and are the only files allowed to import `typeorm`, `@nestjs/typeorm`, or use `InjectRepository`.
  - Transactional work in application layer goes through `ITransactionPort` (opaque `ITransactionScope`); the TypeORM downcast lives only in `TypeormTransactionAdapter` and the repository adapter.
  - Test seeds are SQL files under `scripts/seeds/` applied by `yarn test:seed` after migrations.

## ADR-020 — RabbitMQ as the inter-service message bus

Status: Accepted (2026-05-14). [ADR-020](../docs/adr/020-rabbitmq-as-inter-service-bus.md)

- **Decision:** RabbitMQ (via `@nestjs/microservices` `Transport.RMQ` over `amqp-connection-manager` / `amqplib`) is the transport for both RPC (`ClientProxy.send` + `@MessagePattern`) and events (`ClientProxy.emit` + `@EventPattern`); one queue per service (`retail_queue`, `inventory_queue`, `notification_events`); every payload extends `ICorrelationPayload`.
- **Binding rules for implementers:**
  - `@nestjs/microservices`, `amqplib`, `amqp-connection-manager` are allowed only in `infrastructure/messaging/*-rabbitmq.{adapter,publisher}.ts`. Every other layer goes through a port.
  - Publishers materialize `ClientProxy.send/emit` with `firstValueFrom` — async/await semantics are uniform across RPC and events.
  - Connection URL is the required env var `RABBITMQ_URL`; Joi enforces it.
  - Post-commit event publish failures are `warn`-logged, not raised — no transactional outbox today; at-least-once on the broker side, best-effort on commit-to-publish.
  - All queues bind to the default exchange today — don't wire topic exchanges without a follow-up ADR.

## ADR-021 — In-process single-flight and ±10% TTL jitter on the cache port

Status: Accepted (2026-05-20). [ADR-021](../docs/adr/021-cache-single-flight-and-ttl-jitter.md)

- **Decision:** `ICachePort` gains `singleFlight(key, fn)` — concurrent callers attach to the leader's pending promise; the slot clears in `finally` so a rejected leader doesn't poison the key. `StockCache.set` applies `±10%` TTL jitter (`[ttl*0.9, ttl*1.1)`, floored, never zero). `IStockCachePort.getOrLoad(payload, loader)` composes `get → singleFlight(loader+set)`.
- **Binding rules for implementers:**
  - Cache-aside reads in stock paths go through `stockCache.getOrLoad(...)` — don't compose `get → loader → set` by hand in the use case.
  - Operations dashboards showing "expected expiry at T+60s" need to account for `[54s, 66s)` — the jitter band is documented inline.
  - Single-flight scope is one Node process; cross-replica stampedes still fan out one loader per replica. The repo is single-replica today.
  - Skip-cache branches (`entityManager`/`ITransactionScope` or `ignoreCache: true`) short-circuit *before* `getOrLoad` is reached.

## ADR-022 — Cache-key schema-version and opt-in tenant segments

Status: Accepted (2026-05-20). [ADR-022](../docs/adr/022-cache-keys-tenant-and-schema-version.md)

- **Decision:** Cache-key shape is `ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]`. Per-aggregate version constants (`INVENTORY_STOCK_KEY_VERSION = 'v1'`, `RETAIL_ORDER_KEY_VERSION = 'v1'`) sit next to the builders. Tenant segment is opt-in by argument; never defaulted.
- **Binding rules for implementers:**
  - A breaking DTO shape change = bump the relevant per-aggregate version constant in `libs/cache/cache-keys.ts`. Old entries become unreachable and age out via TTL.
  - The `version` segment is *not* a builder argument — keep it as a constant next to the builder so the live version is greppable.
  - Tenant is opt-in: pass `{ tenantId }` via `opts?: { tenantId?: string }`. A missing `tenantId` omits the segment entirely — never default to `'default'`.
  - `StockCache.invalidate` (now reachable only via `withInvalidation` — see ADR-023) fans out three `delByPrefix` calls per productId during the transition window (current v1, pre-v1 `inventoryStockLegacyPrefix`, pre-ADR-016 `productStockPrefix`); leave the legacy fan-outs in place until the cleanup follow-up.

## ADR-023 — Post-commit cache invalidation enforced by the type system

Status: Accepted (2026-05-20). [ADR-023](../docs/adr/023-cache-invalidate-post-commit-by-type.md)

- **Decision:** `IStockCachePort.invalidate(...)` is removed from the public port surface. Cache invalidation on write is reachable only via `withInvalidation<T>(work, resolveItems, opts)` — the helper awaits `work()`, then calls a private `invalidatePrefixes(items, opts)`. On rejection, no cache mutation.
- **Binding rules for implementers:**
  - Stock write paths wrap their transaction in `stockCache.withInvalidation(work, resolveItems, { correlationId })`; the use case's transaction body lives inside `work`, and `resolveItems(result)` derives the `IStockCacheInvalidateItem[]` from the resolved value.
  - Never resurrect a public `invalidate(...)` on `IStockCachePort` — the type-system contract is the point.
  - The same shape applies when adding new aggregate caches: declare `withInvalidation` on the new port, keep the prefix fan-out private.
  - The `withInvalidation` helper is transaction-API-agnostic (`work: () => Promise<T>`) — it composes with both `entityManager.transaction(...)` and `transactionPort.runInTransaction(...)`.
