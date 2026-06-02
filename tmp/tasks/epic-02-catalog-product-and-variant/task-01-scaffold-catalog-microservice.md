---
epic: epic-02
task_number: 1
title: Scaffold the catalog microservice
depends_on: []
doc_deliverable: docs/implementation/02-catalog-product-and-variant/01-new-catalog-microservice-scaffold.md
adr_deliverable: none
---

# Task 01 — Scaffold the catalog microservice

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the `docs/adr/` documents related to this task.

Most relevant ADRs: **ADR-018** (NestJS monorepo apps + libs), **ADR-004**
(per-module hexagonal), **ADR-007 / ADR-014** (tracer-first import + OTel env),
**ADR-001 / ADR-015** (Pino logger), **ADR-020** (RabbitMQ transport + queue per
service), **ADR-008** (messaging wiring).

## Goal

Stand up a new deployable `catalog-microservice` that boots as an RMQ server on
a new `catalog_queue`, with an empty `catalog` bounded-context module shaped on
the canonical per-module hexagonal template. After this task the service starts,
connects to RabbitMQ, logs "listening", and registers **no** message handlers
yet. No domain, persistence, use cases, or events exist — those arrive in later
tasks.

## Entry state assumed

- The four existing services (`api-gateway`, `inventory-microservice`,
  `retail-microservice`, `notification-microservice`) are present and green.
- There is **no** `apps/catalog-microservice/` directory.
- `libs/contracts/auth/permission.enum.ts` already defines `CATALOG_READ`,
  `CATALOG_WRITE`, `CATALOG_PUBLISH`; `role.enum.ts` already defines
  `CATALOG_MANAGER`; the baseline seed already seeds these. Do **not** re-add them.
- First task — read no carryover.

## Scope

**In**

- The `apps/catalog-microservice/` app skeleton that boots empty.
- The contract enum additions needed for a bootable RMQ service.
- Monorepo wiring: `nest-cli.json`, per-app `tsconfig.app.json`, `package.json`
  scripts, `docker-compose.yml`, `scripts/bash/start-dev.sh`.

**Out**

- Domain, persistence, use cases, events, controllers (later tasks).
- Any `eslint.config.mjs` change for boundaries (see "Architecture-lint note").
- `MicroserviceClientCatalogModule` and any `ROUTING_KEYS` (task-05+).
- `CacheModule` — the catalog service does not cache in this work.

## Contract enum additions

Add exactly these (additive; keep existing members):

- `libs/contracts/microservices/microservice-queue.enum.ts` →
  `CATALOG_QUEUE = 'catalog_queue'` in `MicroserviceQueueEnum`.
- `libs/contracts/microservices/app-name.enum.ts` →
  `CATALOG_MICROSERVICE = 'catalog-microservice'` in `AppNameEnum`.

Do **not** add a `MicroserviceClientTokenEnum.CATALOG_MICROSERVICE` here — no
code injects a catalog client yet; that token arrives in task-05 with the
publisher.

## App skeleton (model on the notification + inventory microservices)

```
apps/catalog-microservice/
  tsconfig.app.json                 # extends ../../tsconfig.json; outDir ../../dist/apps/catalog-microservice
  src/
    main.ts                         # FIRST import: '@retail-inventory-system/observability/tracer'
    app/
      app.module.ts
      index.ts                      # re-exports AppModule
    modules/
      catalog/
        index.ts                    # re-exports CatalogModule (+ entity barrel later)
        catalog.module.ts           # empty @Module({}) for now — providers/controllers added later
```

- `main.ts` mirrors `apps/inventory-microservice/src/main.ts`:
  `NestFactory.createMicroservice<MicroserviceOptions>(AppModule, { transport: Transport.RMQ, options: { urls: [RABBITMQ_URL], queue: MicroserviceQueueEnum.CATALOG_QUEUE, queueOptions: { durable: true } } })`,
  `PinoLogger(new LoggerModuleConfig(AppNameEnum.CATALOG_MICROSERVICE))`, HMR
  block, `logger.info('Catalog Microservice is listening for messages')`.
  **The tracer side-effect import stays the first executable line** (ADR-007).
- `app.module.ts` mirrors `apps/inventory-microservice/src/app/app.module.ts`
  **minus** `CacheModule` and **minus** `DatabaseModule.forRoot(...)` for now
  (no entities yet — task-04 adds `DatabaseModule.forRoot(catalogEntities)`):
  `ConfigModule.forRoot(configModuleConfig)`,
  `LoggerModule.forRoot(new LoggerModuleConfig(AppNameEnum.CATALOG_MICROSERVICE))`,
  `CatalogModule`.
- `catalog.module.ts` is an empty `@Module({})` exported class for now.

## Monorepo + ops wiring

- `nest-cli.json` → add a `catalog-microservice` entry to `projects` mirroring
  the `inventory-microservice` block (root `apps/catalog-microservice`,
  `entryFile: main`, `sourceRoot: apps/catalog-microservice/src`,
  `tsConfigPath: apps/catalog-microservice/tsconfig.app.json`).
- `package.json` scripts → add `build:catalog-microservice`,
  `start:dev:catalog-microservice`, `start:prod:catalog-microservice`
  mirroring the inventory entries.
- `docker-compose.yml` → add a `catalog-microservice` service mirroring the
  **notification-microservice** block (it has `DATABASE_URL`, `REDIS_URL`,
  `RABBITMQ_URL`, `CACHE_TTL_MS_DEFAULT`, `OTEL_SERVICE_NAME`,
  `OTEL_EXPORTER_OTLP_ENDPOINT`, the three `depends_on` health conditions, the
  bind-mount volumes, `command: yarn start:dev:catalog-microservice`, network
  `backend`). Set `OTEL_SERVICE_NAME: catalog-microservice` and
  `container_name: catalog-microservice`. Keep `REDIS_URL` /
  `CACHE_TTL_MS_DEFAULT` to satisfy the shared `libs/config` Joi schema even
  though catalog does not cache — verify against `libs/config` and trim only if
  the schema marks them optional.
- `scripts/bash/start-dev.sh` → extend the `concurrently` block: add `CAT` to
  `--names`, add a colour, and add `"yarn start:dev:catalog-microservice"`.

## Architecture-lint note (do not skip)

`eslint.config.mjs` and `spec/architecture-lint.spec.ts` express the boundaries
rules **generically** via `apps/*/src/modules/*/...` element patterns with
`capture: ['app', 'module']`. A new microservice is matched automatically — there
is **no** per-app entry to add, and you must **not** add one. The
boundaries config is unchanged by this task. (The regression fixtures for the
catalog paths are added later, in task-10.) Just place files at the canonical
paths above so the generic patterns classify them correctly.

## Files to add

- `apps/catalog-microservice/tsconfig.app.json`
- `apps/catalog-microservice/src/main.ts`
- `apps/catalog-microservice/src/app/app.module.ts`
- `apps/catalog-microservice/src/app/index.ts`
- `apps/catalog-microservice/src/modules/catalog/index.ts`
- `apps/catalog-microservice/src/modules/catalog/catalog.module.ts`

## Files to modify

- `libs/contracts/microservices/microservice-queue.enum.ts`
- `libs/contracts/microservices/app-name.enum.ts`
- `nest-cli.json`
- `package.json`
- `docker-compose.yml`
- `scripts/bash/start-dev.sh`

## Files to delete

- None.

## Tests

- No new unit/e2e specs in this task (the service has no behaviour yet). The
  existing `yarn test:unit` and `yarn test:e2e` suites must stay green.
- `scripts/test-db-seed.ts` — no change.
- Boot verification (manual / in carryover "How to verify"):
  `docker compose up -d rabbitmq mysql redis` then `yarn start:dev:catalog-microservice`
  → expect the "Catalog Microservice is listening for messages" log line and a
  bound `catalog_queue` in the RabbitMQ management UI (`http://localhost:15672`).

## Doc deliverable

`docs/implementation/02-catalog-product-and-variant/01-new-catalog-microservice-scaffold.md`.
Outline:

1. **What this service is** — the catalog bounded context's home; why a separate
   deployable (ADR-018) rather than a module inside an existing service.
2. **Boot shape** — RMQ server on `catalog_queue`, tracer-first import, Pino
   logger, no HTTP surface (writes/reads are proxied by the gateway later).
3. **Per-module hexagonal skeleton** — the `modules/catalog/{domain,application,infrastructure,presentation}`
   split it will grow into (ADR-004), modelled on the notification template.
4. **Monorepo + ops wiring** — `nest-cli.json`, `tsconfig.app.json`, scripts,
   `docker-compose.yml`, `start-dev.sh`; the OTel env vars (ADR-014).
5. **Why boundaries needed no config change** — the generic capture-based rules.

Write for a reader who has only the repository. No `tmp/` references; do not use
the words "epic"/"task".

## Carryover to read

None — first task.

## Carryover to produce

Write `tmp/tasks/epic-02-catalog-product-and-variant/carryover-01.md` capturing:

- **Entry state for task-02** — the catalog app boots empty on `catalog_queue`;
  `MicroserviceQueueEnum.CATALOG_QUEUE` and `AppNameEnum.CATALOG_MICROSERVICE`
  now exist; the `retail_db` schema is unchanged (the inventory `product` stub
  still exists and is task-02's target).
- **Files added / modified** — the list above.
- **Key decisions** — no `CacheModule`/`DatabaseModule.forRoot` yet; no client
  token yet; boundaries config intentionally untouched.
- **Known gaps** — `catalog.module.ts` is empty; `DatabaseModule.forRoot` is
  added in task-04; the publisher client token + module in task-05.
- **How to verify** — boot command above; `yarn lint`; `yarn test:unit`.

## Exit criteria

- [ ] `apps/catalog-microservice/` boots as an RMQ server on `catalog_queue`
      and logs the "listening" line; `catalog_queue` appears in RabbitMQ.
- [ ] `MicroserviceQueueEnum.CATALOG_QUEUE` and `AppNameEnum.CATALOG_MICROSERVICE`
      exist; no `MicroserviceClientTokenEnum` change.
- [ ] `nest-cli.json`, `package.json` scripts, `docker-compose.yml`, and
      `start-dev.sh` include the catalog service.
- [ ] `eslint.config.mjs` is unchanged for boundaries; `yarn lint` passes
      (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; `yarn test:e2e` passes (regression — no new e2e).
- [ ] `docs/implementation/02-catalog-product-and-variant/01-new-catalog-microservice-scaffold.md` is written.
- [ ] The self-containment grep is clean:
      `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`.
- [ ] `carryover-01.md` is written.
