# task-04 — Extract shared libs: integration (Phase 1, part 2)

## Context

- Migration plan: `docs/architecture-migration-plan/parts/recommendation.md`
- Conventions preamble: `docs/architecture-migration-plan/tasks/task-01-review-project-and-update-plan.md`
- Previous carryover: `docs/architecture-migration-plan/tasks/_carryover-03.md`
- Project conventions: `CLAUDE.md`
- Where we are in the migration: foundation libs (`contracts`,
  `database`, `common`) are in place. This task adds the integration
  libs that wrap I/O concerns: `libs/messaging` (RabbitMQ),
  `libs/cache` (Redis), `libs/observability` (Pino + OTel skeleton),
  `libs/ddd` (framework-free building blocks). After this task, every
  cross-cutting concern in the apps has a port-and-adapter home it
  can move into. `libs/auth` is **not** in scope here — task-06 builds
  it from scratch.

## Prerequisites

- [ ] `_carryover-03.md` exists and was read first.
- [ ] Build is green on entry.

## Goal

Land the four integration libraries — each with a port (or
constants/interfaces only, where there is no behavioural seam) and at
least one adapter — so that subsequent app-alignment tasks (task-05
to task-09) can wire ports without inventing them. No app modules
under `apps/*/src/` are rewritten in this task; only their imports
flip from ad-hoc usages to the new libs.

## Steps

1. **`libs/messaging/`** — wrap RabbitMQ.
   - `messaging.module.ts` — provides the configured
     `ClientProxyFactory.create({ transport: Transport.RMQ, … })`
     reading `RABBITMQ_URL` from config. Migrate the existing
     `MicroserviceClientConfiguration` factory and the two
     `MicroserviceClientRetailModule` / `MicroserviceClientInventoryModule`
     wrappers from `libs/common/{config,modules}` into this lib.
   - `routing-keys.constants.ts` — define dotted constants like
     `ROUTING_KEYS.RETAIL_ORDER_CREATE = 'retail.order.create'`,
     `INVENTORY_PRODUCT_STOCK_GET = 'inventory.product-stock.get'`.
     The current `MicroserviceMessagePatternEnum` (relocated to
     `libs/contracts` in task-03) uses underscores —
     e.g. `inventory_product_stock_get`. Migrating the wire format
     is **breaking**: gateway and microservices must agree. Plan A:
     change the enum values in one PR and ship gateway + every
     microservice together (zero downtime since the test infra is
     reset on every run). Plan B: keep the existing snake_case
     values as constants and skip the rename. Decide and record in
     `_carryover-04.md`. Default: rename — the migration is the
     right time to fix the naming.
   - `exchanges.constants.ts` — define
     `EXCHANGES = { RETAIL: 'retail', INVENTORY: 'inventory', NOTIFICATION: 'notification' }`.
     RabbitMQ today uses one queue per service without explicit
     exchanges; the constants land here so future routing changes
     have a home.
   - `rabbitmq.client.factory.ts` — factory that builds a
     `ClientProxy` for a given exchange/queue.
   - Keep the existing `MicroserviceQueueEnum` and
     `MicroserviceClientTokenEnum` as re-exports from
     `@retail-inventory-system/contracts` (where they live after
     task-03) — `libs/messaging` is the consumer, `libs/contracts`
     remains the source of truth for transport identifiers.

2. **`libs/cache/`** — Redis cache-aside.
   - `cache.port.ts` — interface `CachePort` with `get<T>(key)`,
     `set<T>(key, value, ttl)`, `del(key)`, `wrap<T>(key, ttl, fn)`.
   - `redis-cache.adapter.ts` — implements `CachePort` using the
     existing `@nestjs/cache-manager` + `@keyv/redis` setup.
     Migrate from `libs/common/cache/cache.helper.ts` (the existing
     CacheHelper key registry) and the `cacheModuleConfig` factory
     from `libs/config/cache-module.config.ts`. **Preserve** the
     ADR-002 cache-aside contract for product-stock — task-04 only
     introduces the port/adapter shape; the actual product-stock
     façade migration happens in task-08.
   - `decorators/cacheable.decorator.ts` — method decorator that
     resolves a `CachePort` from the DI container and wraps the
     decorated method with read-through caching keyed by the
     decorator argument template (`'ris:retail:product:{id}'`).
     Generalized application is task-11.
   - `cache-keys.ts` — central registry of cache-key templates.
     Migrate the existing `CacheHelper.keys.productStock(...)`
     into this registry; existing keys must continue to resolve
     identically to keep production cache entries valid across the
     deploy.
   - `cache.module.ts` — Nest module binding `CachePort` symbol to
     `RedisCacheAdapter`.
   - The existing audit findings touching cache
     (`docs/audits/audit-2026-05-08.md`: CACHE-001 through
     CACHE-012) remain unresolved — task-11 is where they're
     re-evaluated. This task does **not** silently fix them.

3. **`libs/observability/`** — Pino + OTel skeleton.
   - `tracer.ts` — boots the OTel `NodeSDK` with auto-instrumentation
     for HTTP, MySQL (TypeORM), Redis, AMQP. **This file must be
     importable as a side-effect with no Nest involvement** because
     it has to run before `NestFactory.create*()`. Concrete
     `NodeSDK` config (exporter, propagator, attributes) is
     finished in task-10; this task ships the file shell so app
     `main.ts`s can already import it.
   - `logger.module.ts` — relocate `libs/config/logger-module.config.ts`
     unchanged; add a `traceId`/`spanId` enrichment hook stub
     (active in task-10).
   - `trace-context.interceptor.ts` — Nest interceptor that copies
     OTel context into Pino bindings (stub; active in task-10).
   - `http-context.middleware.ts` — relocate the existing
     `CorrelationMiddleware` and decorator from
     `libs/common/correlation/`. The middleware behaviour and the
     `CORRELATION_ID_HEADER` constant are preserved verbatim;
     ADR-001's contract still holds.
   - `metrics.module.ts` — placeholder, may be empty until task-10.

4. **`libs/ddd/`** — framework-free building blocks.
   - `entity.base.ts`, `aggregate-root.base.ts`,
     `value-object.base.ts`, `domain-event.base.ts`,
     `repository.port.ts`. No `@nestjs/*`, no TypeORM. Pattern from
     Sairyss/domain-driven-hexagon scaled down to TypeORM-native
     usage.

5. **Update `tsconfig.json` aliases** to add
   `@retail-inventory-system/{messaging,cache,observability,ddd}`.
   Mirror in `jest.unit.config.js`, `jest.e2e.config.js`, and
   `nest-cli.json`'s `projects` block.

6. **Replace ad-hoc imports under `apps/`** with the new libs:
   - Anywhere a microservice imports the existing
     `MicroserviceClientRetailModule` / `MicroserviceClientInventoryModule`
     from `libs/common/modules`, repoint at
     `@retail-inventory-system/messaging`.
   - Anywhere correlation-ID utilities are imported from
     `libs/common/correlation`, repoint at
     `@retail-inventory-system/observability`.
   - Anywhere the existing `libs/common/cache/CacheHelper` is
     imported, repoint at `@retail-inventory-system/cache`. The
     consumer is `apps/inventory-microservice/.../product-stock-common-cache.service.ts`
     — confirm one consumer path remains green.
   The apps must still compile; logic is not refactored in this
   task.

## Documentation updates required

- [ ] `README.md`: extend the "Shared libraries" section from
  task-03 to cover all integration libs. Note that `auth` arrives
  in task-06.
- [ ] `CLAUDE.md`: list each integration lib's purpose + import
  alias + the **forbidden imports** rule (e.g., "domain code may
  not import `@retail-inventory-system/messaging` or
  `@retail-inventory-system/cache`").
- [ ] `docs/adr/NNN-cache-aside-via-libs-cache.md`: new ADR
  formalizing the port/adapter shape (extends ADR-002 — the existing
  ADR keeps Status: Accepted; this new ADR refines the abstraction).
- [ ] `docs/adr/NNN-pino-and-opentelemetry.md`: new ADR documenting
  the trace+log correlation pattern (does **not** supersede ADR-001
  — they cover complementary concerns).
- [ ] `docs/adr/NNN-rabbitmq-via-libs-messaging.md`: new ADR
  documenting routing-key conventions (dotted vs snake_case
  decision from step 1) and the publisher-port pattern.

## Verification

- [ ] `yarn install` succeeds.
- [ ] `yarn build` succeeds for all four apps.
- [ ] `yarn lint` succeeds.
- [ ] `yarn test:unit` succeeds.
- [ ] Each new lib has at least one unit test (port-adapter contract
  or decorator behaviour).
- [ ] `libs/messaging`, `libs/cache`, `libs/observability`, `libs/ddd`
  exist with a `port` (or constants) + at least one adapter (or
  factory) where the recommendation requires one.

## Carryover

Write `_carryover-04.md` with:
- New lib files (paths + roles).
- Import-site rewrites under `apps/` (table: old path → new path).
- The routing-key naming decision from step 1 (rename vs keep) and
  the rationale.
- Any observed behavioural drift (e.g., a routing-key rename
  required updating the e2e snapshot).
- The 3-digit ADR numbers assigned for cache-aside-via-port,
  pino+opentelemetry, and rabbitmq-via-libs-messaging.
- Verification results.
- Suggested adjustments to task-05 (gateway).
