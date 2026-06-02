# 01 — The catalog microservice scaffold

This document records the standing-up of `catalog-microservice`, a new
deployable that will own the **catalog** bounded context (products and their
variants). At this stage the service is intentionally inert: it boots, connects
to RabbitMQ on a dedicated `catalog_queue`, logs that it is listening, and
registers **no** message handlers. Its domain, persistence, use cases, events,
and controllers arrive in the sibling documents that follow this one.

## 1. What this service is

The catalog bounded context — the authoritative list of sellable products and
their variants — gets its own deployable rather than living as a module inside
the inventory or retail services. Three reasons, all grounded in the existing
architecture:

- **A bounded context maps to a deployable** ([ADR-018](../../adr/018-nestjs-monorepo-apps-and-libs.md)).
  Catalog has a distinct lifecycle from stock and orders: products are authored
  and published by catalog managers, whereas stock levels move on every
  reservation and orders move on every checkout. Folding catalog into inventory
  would couple two contexts that change for different reasons and at different
  rates.
- **The inventory service already carries a `product` stub** that only exists as
  a foreign-key anchor for `product_stock`. Catalog is where product identity
  *belongs*; co-locating it with inventory would entrench that accident. (The
  removal of the inventory-side stub and the migration of product ownership to
  catalog are handled in the immediately following work.)
- **Authorization is already catalog-aware.** The shared permission registry
  (`libs/contracts/auth/permission.enum.ts`) defines `catalog:read`,
  `catalog:write`, and `catalog:publish`, and the seed provisions a
  `catalog-manager` role bundling them (see
  [ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)). The
  service those permissions gate now exists.

The catalog service has **no HTTP surface**. Like the inventory and retail
services, all of its reads and writes are proxied by the API gateway over
RabbitMQ; the gateway remains the single HTTP entry point and the single place
that authenticates and authorizes a caller. The gateway-side catalog module and
its routes are added later.

## 2. Boot shape

`apps/catalog-microservice/src/main.ts` mirrors the inventory service's
bootstrap exactly, with the catalog identifiers substituted:

- **The first executable import is `@retail-inventory-system/observability/tracer`**
  ([ADR-007](../../adr/007-pino-and-opentelemetry.md) /
  [ADR-014](../../adr/014-otel-exporter-otlp-http-and-jaeger.md)). OpenTelemetry
  auto-instrumentation patches `amqplib` (and, once persistence lands, `mysql2`)
  at module-load time. Any transport client `require()`'d before the tracer side
  effect runs would be invisible to tracing, so this line must stay first — no
  import may be hoisted above it.
- The app is created with `NestFactory.createMicroservice<MicroserviceOptions>`
  using `Transport.RMQ`, the connection URL from `RABBITMQ_URL`, and
  `queue: MicroserviceQueueEnum.CATALOG_QUEUE` with `queueOptions.durable = true`
  — one durable queue per service, per
  [ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md).
- Logging is Pino via `nestjs-pino`
  ([ADR-001](../../adr/001-structured-logging-with-pino.md) /
  [ADR-015](../../adr/015-pino-trace-correlation.md)), configured with
  `new LoggerModuleConfig(AppNameEnum.CATALOG_MICROSERVICE)` so every log line
  carries `app: "catalog-microservice"`. The bootstrap logs
  `Catalog Microservice is listening for messages` once `app.listen()` resolves.
- The standard webpack-HMR `module.hot` accept/dispose block is present so
  `yarn start:dev:catalog-microservice` hot-reloads in watch mode.

`apps/catalog-microservice/src/app/app.module.ts` is the inventory app module
**minus two imports**:

- **No `CacheModule`.** The catalog service does not cache. Product/variant
  reads are low-volume and authored, not the high-fanout aggregate that
  justified Redis cache-aside for stock
  ([ADR-002](../../adr/002-redis-cache-aside-product-stock.md)).
- **No `DatabaseModule.forRoot(...)` yet.** There are no catalog entities at this
  stage, and `DatabaseModule.forRoot([])` with an empty entity list would be
  noise. Persistence wiring (`DatabaseModule.forRoot(catalogEntities)`) is added
  with the first entities in a following document.

What remains is the minimum that every service needs to boot and be observable:
`ConfigModule.forRoot(configModuleConfig)` (Joi-validated env, per
[ADR-005](../../adr/005-split-shared-common-into-bounded-libs.md)),
`LoggerModule.forRoot(...)`, and the (empty) `CatalogModule`.

### Environment variables

The `configModuleConfig` Joi schema in `libs/config` is shared by every service,
so the catalog container must still satisfy its **required** keys even for keys
catalog does not functionally use:

| Variable | Why catalog sets it |
| --- | --- |
| `RABBITMQ_URL` | The transport the service binds to — its reason for existing. |
| `DATABASE_URL` | Required by the shared schema; consumed once persistence lands. |
| `REDIS_URL` | Required by the shared schema (`.required()`), even though catalog does not cache — it is set to keep validation passing, not because a Redis client is opened. |
| `OTEL_SERVICE_NAME` | Required; set to `catalog-microservice` so its spans are distinguishable in Jaeger. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Required; the collector endpoint, must end in `/v1/traces`. |

`CACHE_TTL_MS_DEFAULT` is deliberately **omitted** from the catalog container's
environment. Unlike `REDIS_URL`, that key is optional in the shared schema
(`.default(60000)`), and the catalog service has no cache to tune — carrying it
would imply a caching concern the service does not have. This is the one place
the catalog compose block diverges from the notification block it is otherwise
modelled on.

## 3. Per-module hexagonal skeleton

The service follows the per-module hexagonal layout that every service in this
repository uses ([ADR-004](../../adr/004-adopt-hexagonal-architecture-per-service.md)),
modelled on the notification microservice, which is the canonical template. Its
single bounded context is `catalog`:

```
apps/catalog-microservice/src/
  main.ts                         # tracer-first import, RMQ bootstrap, Pino logger
  app/
    app.module.ts                 # ConfigModule + LoggerModule + CatalogModule
    index.ts                      # re-exports AppModule
  modules/
    catalog/
      index.ts                    # re-exports CatalogModule (entity barrel added later)
      catalog.module.ts           # empty @Module({}) — providers/controllers added later
```

`CatalogModule` is an empty `@Module({})` today. As the context grows it gains
the four canonical layers under `modules/catalog/`:

- `domain/` — the `Product` and `Variant` aggregates and their value objects,
  framework-free (no `@nestjs/*`, no TypeORM, no `class-validator`).
- `application/` — use cases plus the port interfaces they depend on
  (`application/ports/`), injected by symbol; no direct dependency on adapters.
- `infrastructure/` — TypeORM entities and repositories, and the RabbitMQ
  publisher; the only layer allowed to import transport/ORM packages.
- `presentation/` — `@MessagePattern` / `@EventPattern` handlers (the catalog
  service is RMQ-only, so there are no HTTP controllers here).

Keeping the empty module on these exact paths means the boundaries lint (next
section) classifies future files correctly the moment they are added.

## 4. Monorepo + ops wiring

A new deployable is, mechanically, a new `apps/<service>/` folder plus four
registrations ([ADR-018](../../adr/018-nestjs-monorepo-apps-and-libs.md)):

- **`nest-cli.json`** — a `catalog-microservice` entry under `projects` mirroring
  the inventory block (`root: apps/catalog-microservice`, `entryFile: main`,
  `sourceRoot: apps/catalog-microservice/src`,
  `tsConfigPath: apps/catalog-microservice/tsconfig.app.json`). This is what lets
  `nest build catalog-microservice` resolve the app.
- **`apps/catalog-microservice/tsconfig.app.json`** — extends the root
  `tsconfig.json` and sets `outDir` to `../../dist/apps/catalog-microservice`;
  identical in shape to the other apps'.
- **`package.json` scripts** — `build:catalog-microservice`,
  `start:dev:catalog-microservice` (webpack-HMR watch), and
  `start:prod:catalog-microservice` (`node dist/apps/catalog-microservice/main.js`),
  each mirroring the inventory entries.
- **`docker-compose.yml`** — a `catalog-microservice` service modelled on the
  notification block: the three `depends_on` health conditions (rabbitmq, mysql,
  redis), the source bind-mount volumes, `command: yarn start:dev:catalog-microservice`,
  the `backend` network, and the environment described in §2 with
  `OTEL_SERVICE_NAME: catalog-microservice` and `container_name: catalog-microservice`.
- **`scripts/bash/start-dev.sh`** — the `concurrently` block gains a `CAT` name,
  a colour, and `yarn start:dev:catalog-microservice`, so `yarn start:dev` boots
  the catalog service alongside the others.

No `MicroserviceClient*` module or `ROUTING_KEYS` entries are added at this stage:
nothing publishes to or calls the catalog service yet. The client token and the
outbound publisher wiring arrive with the first event producer, in later work.

## 5. Why the boundaries config needed no change

The architecture-lint rules in `eslint.config.mjs`
([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)) are
expressed **generically**. Element types are matched by glob patterns such as
`apps/*/src/modules/*/domain/**` with `capture: ['app', 'module']`, not by
hard-coded per-service paths. A brand-new microservice placed at the canonical
paths is therefore classified automatically — its `domain/`, `application/`,
`infrastructure/`, and `presentation/` folders inherit the same per-layer import
denylists as every other service, with no new rule and no new entry.

The corollary is a discipline: there is nothing to add, and adding a
catalog-specific rule would be wrong. The lint config is unchanged by this work.
(The regression fixtures that assert the rules fire for catalog-shaped paths are
added with the lint-coverage follow-up.)
