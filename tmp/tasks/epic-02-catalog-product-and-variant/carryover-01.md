# Carryover 01 → task-02

Task-01 ("Scaffold the catalog microservice") is complete. This note is the
entry state for task-02 (remove the inventory `product` stub).

## Entry state for task-02

- A new deployable `apps/catalog-microservice/` exists and **boots empty**: it
  starts as an RMQ server on `catalog_queue`, logs
  `Catalog Microservice is listening for messages`, and registers **no** message
  handlers. Verified live (see "How to verify").
- `MicroserviceQueueEnum.CATALOG_QUEUE = 'catalog_queue'` and
  `AppNameEnum.CATALOG_MICROSERVICE = 'catalog-microservice'` now exist in
  `libs/contracts/microservices/`.
- The `retail_db` schema is **unchanged**. The inventory-side `product` stub
  (the `product` table + the inventory `Product` entity, an FK anchor for
  `product_stock`) still exists and is task-02's removal target. No migration
  was authored in this task.
- `catalog.module.ts` is an empty `@Module({})`; the catalog app has **no**
  `domain/application/infrastructure/presentation` content yet.
- The four pre-existing services remain green (lint, unit, build all pass).

## Files added

- `apps/catalog-microservice/tsconfig.app.json`
- `apps/catalog-microservice/src/main.ts`
- `apps/catalog-microservice/src/app/app.module.ts`
- `apps/catalog-microservice/src/app/index.ts`
- `apps/catalog-microservice/src/modules/catalog/index.ts`
- `apps/catalog-microservice/src/modules/catalog/catalog.module.ts`
- `docs/implementation/02-catalog-product-and-variant/01-new-catalog-microservice-scaffold.md`

## Files modified

- `libs/contracts/microservices/microservice-queue.enum.ts` — added `CATALOG_QUEUE`.
- `libs/contracts/microservices/app-name.enum.ts` — added `CATALOG_MICROSERVICE`.
- `nest-cli.json` — added the `catalog-microservice` project entry.
- `package.json` — added `build:catalog-microservice`,
  `start:dev:catalog-microservice`, `start:prod:catalog-microservice`.
- `docker-compose.yml` — added the `catalog-microservice` service block.
- `scripts/bash/start-dev.sh` — added `CAT` (green) +
  `yarn start:dev:catalog-microservice` to the `concurrently` block.
- `README.md` — services table row, system diagram box, scripts tables
  (four → five).
- `CLAUDE.md` — app tree, RabbitMQ queues line, Service Structure intro
  (three → four microservices, catalog scaffold note).

## Files deleted

- None.

## Key decisions & deviations

- **No `CacheModule` and no `DatabaseModule.forRoot(...)`** in
  `catalog-microservice` `app.module.ts`. Catalog does not cache; entities arrive
  in task-04, which adds `DatabaseModule.forRoot(catalogEntities)`.
- **No `MicroserviceClientTokenEnum.CATALOG_MICROSERVICE`** and **no
  `ROUTING_KEYS` entries** — nothing injects a catalog client or calls catalog
  yet. The client token + publisher wiring is task-05's.
- **`docker-compose.yml` catalog block omits `CACHE_TTL_MS_DEFAULT`.** Verified
  against `libs/config`: `REDIS_URL` is `.required()` (kept, even though catalog
  does not cache), but `CACHE_TTL_MS_DEFAULT` has `.default(60000)` (optional).
  Per the task's "trim only if the schema marks them optional" instruction it was
  dropped — catalog has no cache to tune. This is the only divergence from the
  notification block the catalog block was modelled on.
- **`eslint.config.mjs` boundaries config is intentionally untouched.** The rules
  match `apps/*/src/modules/*/...` generically with `capture: ['app', 'module']`,
  so the catalog paths classify automatically. The regression fixtures for the
  catalog paths are task-10's.
- `main.ts` mirrors the inventory bootstrap (`bufferLogs: true`, no `noAck`); the
  tracer side-effect import is the first executable line (ADR-007).

## Known gaps (owned by later tasks)

- `catalog.module.ts` is empty → domain/persistence/use-cases/events fill it in
  tasks 03–07.
- `DatabaseModule.forRoot(catalogEntities)` is added in **task-04**.
- The publisher `MicroserviceClientTokenEnum` + `MicroserviceClientCatalogModule`
  + `ROUTING_KEYS` arrive in **task-05+**.
- The inventory `product` stub removal + migration is **task-02**.
- The boundaries-lint regression fixtures for catalog paths are **task-10**.

## How to verify

```bash
# 1. Build + lint + unit (all green in this task)
yarn build:catalog-microservice
yarn lint                      # --max-warnings 0, passes
yarn test:unit                 # 313 passed

# 2. Boot verification
docker compose up -d rabbitmq mysql redis
# (catalog only connects to RabbitMQ; mysql/redis just satisfy the shared Joi schema)
OTEL_SDK_DISABLED=true node dist/apps/catalog-microservice/main.js
#   → logs "Catalog Microservice is listening for messages"
docker exec rabbitmq rabbitmqctl list_queues name consumers
#   → catalog_queue appears with 1 consumer, 0 message handlers
#   (or open the RabbitMQ management UI at http://localhost:15672, guest/guest)

# 3. Self-containment gate (clean)
grep -rniE 'tmp/|\bepic\b|\btask\b' \
  docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md
```

Note: RabbitMQ was left running after this task's verification; tear it down with
`yarn test:infra:down` if a clean slate is needed.
