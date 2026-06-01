# 01 — Scaffold the new `catalog-microservice`

> Epic-02 · Task-01 · Foundation-only. This task stands up an empty, boot-ready
> fifth Nest application. No catalog domain code exists yet — `Product` /
> `ProductVariant` arrive in task-02.

## 1. Why a fifth microservice (and not a fifth module inside an existing one)

Catalog is its own bounded context: it is the **source of truth for `Product`
and `ProductVariant`**, and every downstream cluster (inventory stock, retail
orders, pricing) keys on `variantId`. Co-locating that aggregate inside the
inventory-microservice would entangle two lifecycles that change for different
reasons — catalog authoring (SKU creation, variant attributes, descriptions)
versus stock movement (reservations, replenishment, low-stock alerts).

Splitting catalog out:

- keeps catalog reads/writes **off the inventory hot path** — a burst of
  product-authoring traffic never contends with stock reservation throughput;
- lets the inventory store **reduce to its own concerns** (stock + movements +
  reservations) — task-08 drops the old inventory-resident `product` table once
  the catalog service owns the identity;
- matches the per-service hexagonal model the repo already commits to
  (ADR-004 / ADR-018): one deployable per bounded context, shared code in
  `libs/`.

The cost is one more queue and one more container — both cheap, both wired the
same way as the existing four.

## 2. The per-module shape, recapped

Every service in `apps/` uses the per-module hexagonal layout
(ADR-004 / ADR-009 / ADR-012 / ADR-013). The cleanest existing reference is
`apps/notification-microservice/src/modules/notifications/` (ADR-011 names it
the canonical template). The new tree mirrors it:

```
apps/catalog-microservice/
├── tsconfig.app.json
└── src/
    ├── main.ts                       # tracer-first import, RMQ microservice bootstrap
    ├── app/
    │   ├── app.module.ts             # LoggerModule + DatabaseModule.forRoot([]) + MessagingModule + CatalogModule
    │   └── index.ts                  # re-exports AppModule
    └── modules/
        └── catalog/
            ├── index.ts              # barrel — re-exports CatalogModule (task-02 fills it)
            ├── domain/.gitkeep       # empty — task-02
            ├── application/.gitkeep   # empty — task-02
            ├── infrastructure/
            │   └── catalog.module.ts # empty Nest module — DatabaseModule.forFeature([]) placeholder
            └── presentation/.gitkeep  # empty — task-02
```

The empty `domain/`, `application/`, `presentation/` directories are kept in Git
via `.gitkeep` so the per-module tree physically exists — that is what lets the
`eslint-plugin-boundaries` globs "see" the catalog module before any code lands.

## 3. Monorepo wiring summary

| File | Change |
| --- | --- |
| `nest-cli.json` | Fifth `projects` entry (`catalog-microservice`). |
| `package.json` | `build:` / `start:dev:` / `start:prod:` script trio, mirroring the four existing families. |
| `scripts/bash/start-dev.sh` | Added `CAT` to the `concurrently` runner so `yarn start:dev` boots all five. |
| `docker-compose.yml` | `catalog-microservice` service — identical shape to `inventory-microservice`, swapping the app name. Consumer-only: **no exposed port**. |
| `infrastructure/otel-collector-config.yaml` | **No change** — see §5. |
| `eslint.config.mjs` | **No change** — see §6. |
| `libs/contracts/microservices/*.enum.ts` | `MicroserviceQueueEnum.CATALOG_QUEUE`, `MicroserviceClientTokenEnum.CATALOG_MICROSERVICE`, `AppNameEnum.CATALOG_MICROSERVICE`. |
| `libs/messaging/` | New `MicroserviceClientCatalogModule` + barrel export. |

**Why the same `DATABASE_URL` is reused.** There is a single MySQL instance and a
single `retail_db` schema. The catalog tables (task-02) live alongside the rest
by deliberate choice — `DatabaseModule.forRoot([])` points at the same
connection string as every other service. A dedicated catalog schema (or a
separate physical database) is a Day-2 question: it buys blast-radius isolation
at the cost of cross-schema joins and a second migration pipeline, and nothing
in epic-02 needs it yet. `synchronize` stays off (ADR-019); task-02 ships the
catalog tables as a hand-authored migration.

`AppNameEnum.CATALOG_MICROSERVICE` was added alongside the queue/token enums
because `main.ts` and `app.module.ts` construct `new LoggerModuleConfig(AppNameEnum.CATALOG_MICROSERVICE)`
— the logger's service tag is sourced from that enum, exactly as the other four
apps do.

## 4. MessagingModule + the new `catalog_queue`

The new `MicroserviceClientCatalogModule` is a line-for-line mirror of
`MicroserviceClientNotificationModule`: it registers a `ClientsModule` async
client bound to `MicroserviceClientTokenEnum.CATALOG_MICROSERVICE` over
`MicroserviceQueueEnum.CATALOG_QUEUE = 'catalog_queue'`, and is re-exported from
`libs/messaging/index.ts`.

`main.ts` boots the inbound side with
`NestFactory.createMicroservice(AppModule, { transport: Transport.RMQ, options: { queue: CATALOG_QUEUE, queueOptions: { durable: true }, noAck: false } })`
— the exact options block the inventory microservice uses. On boot, the Nest RMQ
transport asserts the durable `catalog_queue`; verified live (`rabbitmqctl
list_queues` shows `catalog_queue`).

**Routing keys are deferred to task-03.** No `catalog.product.*` dotted constants
exist yet — the queue is provisioned, the patterns come with the write-side use
cases.

## 5. Tracer-first-import discipline

`import '@retail-inventory-system/observability/tracer';` is the **very first
line** of `main.ts`, ahead of every other import. This is the binding rule from
[ADR-007](../../adr/007-pino-and-opentelemetry.md) §"Side-effect import for OTel
bootstrap": the OpenTelemetry SDK patches the Node module loader (HTTP, MySQL,
Redis, amqplib auto-instrumentations) **at module load**. Any client `require()`d
before the tracer side-effect runs is invisible to OTel, silently disabling
trace correlation across the service boundary. ADR-014 / ADR-015 layer the OTLP
exporter and Pino `traceId`/`spanId` injection on top of that decision but do not
redefine the import-order invariant.

No app-local `otel.setup.ts` is created. Every microservice in the repo imports
the shared `libs/observability` tracer; the catalog scaffold follows that
convention. Runtime trace routing comes from `OTEL_SERVICE_NAME=catalog-microservice`
set in the docker-compose env block, not from any app-local bootstrap file.

**Why the OTel collector config needs no change.** `infrastructure/otel-collector-config.yaml`
is a generic `otlp → batch → jaeger` pipeline — it does **not** enumerate service
names. The per-service identity travels as the OTel `service.name` resource
attribute (sourced from `OTEL_SERVICE_NAME`), which the collector forwards to
Jaeger untouched. Adding a fifth service is therefore free at the collector
layer; `grep -n 'inventory-microservice' infrastructure/otel-collector-config.yaml`
returns nothing, confirming there is no allowlist to extend.

## 6. Boundaries lint coverage

The `eslint-plugin-boundaries` taxonomy (ADR-017) captures app-layer elements
with the glob `apps/*/src/modules/*/{domain,application,infrastructure,presentation}/**`
— the `*` in the app position matches `catalog-microservice` automatically, with
**no explicit app allowlist** to extend. `yarn lint --max-warnings 0` runs clean
against the new tree, producing no `boundaries/element-types` "unknown element"
warnings. Decision recorded: **no `eslint.config.mjs` change required**.

To lock that guarantee under CI, `spec/architecture-lint.spec.ts` gains a
`catalog-microservice scaffold (epic-02)` fixture block: one synthetic violation
per element type (domain → `@nestjs/common`, application-use-case → `typeorm`,
application-port → `typeorm`, presentation → `@keyv/redis`, infrastructure →
cross-app reach), each asserting the `boundaries/dependencies` ruleId fires.
Task-09 will revisit this if the catalog modules need additional fixtures.

## 7. What this task did NOT do

- **Domain + persistence + migration** — `Product` / `ProductVariant` aggregates,
  TypeORM entities, mappers, and the catalog tables migration land in **task-02**.
- **Write-side use cases + events + routing keys** — `catalog.product.*` patterns
  and the create/update flows land in **task-03**.
- **Dropping the old inventory `product` table** — the inventory-resident product
  identity is retired in **task-08**, once the catalog service owns it.

## Carryover produced (consumed by task-02 onward)

- The application boots empty: an empty `CatalogModule` placeholder, no entities
  registered with `DatabaseModule`, no presentation handlers, no use cases.
- `MicroserviceQueueEnum.CATALOG_QUEUE` + `MicroserviceClientTokenEnum.CATALOG_MICROSERVICE`
  are available to task-06 (gateway adapter) and any future consumer.
- `MicroserviceClientCatalogModule` is exported from `libs/messaging/`.
- `yarn start:dev:catalog-microservice` exists; CI in any later task can rely on it.
