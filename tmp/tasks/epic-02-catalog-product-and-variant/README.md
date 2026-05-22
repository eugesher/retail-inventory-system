---
epic: epic-02
source_epic_file: tmp/epics/epic-02-catalog-product-and-variant.md
---

# Epic 02 — Task Index

Decomposition of `tmp/epics/epic-02-catalog-product-and-variant.md` into 9 sequential, self-contained execution tasks. Each task file states its entry-state assumption (what previous tasks left on disk), the concrete files to add/modify/delete, the doc deliverable, and the exit criteria. The decomposition mirrors the layout used for `epic-01`.

## Sequence and dependencies

Tasks depend on each other through the `Carryover Between Tasks` table in the epic. Do them in order; do not parallelize. Task-01 stands up the new microservice skeleton, tasks 2–5 fill it with the catalog domain + use cases + read path, task-06 wires the api-gateway side, task-07 backfills HTTP documentation, task-08 removes the obsolete inventory `product` table, and task-09 closes out with seeds, README, CLAUDE.md, and arch-lint fixtures.

| #   | Task                                                                                                                                              | Touches                                                                                                                                                                                                                                                                                          | Doc deliverable                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 01  | [Scaffold the new `catalog-microservice`](task-01-scaffold-catalog-microservice.md)                                                               | `apps/catalog-microservice/` (new tree), `nest-cli.json`, `package.json`, `docker-compose.yml`, `infrastructure/otel-collector-config.yaml`, `eslint.config.mjs`, `spec/architecture-lint.spec.ts`, `libs/contracts/microservices/`                                                               | `01-new-catalog-microservice-scaffold.md`                                                                        |
| 02  | [Add `Product` + `ProductVariant` domain + persistence](task-02-product-and-variant-domain-and-persistence.md)                                    | `apps/catalog-microservice/src/modules/catalog/domain/`, `…/infrastructure/persistence/`, `…/application/ports/`, new migration `CreateProductAndProductVariantTables`                                                                                                                           | `02-product-and-variant-domain.md` + `03-product-and-variant-persistence.md`                                     |
| 03  | [Implement `Register Product` + `Add Variant` use cases + event publisher wiring](task-03-register-product-and-add-variant-use-cases.md)          | `…/application/use-cases/`, `…/infrastructure/messaging/`, `libs/messaging/routing-keys.constants.ts`, `libs/messaging/microservice-client-catalog.module.ts` (new), `libs/contracts/microservices/{microservice-queue.enum.ts,microservice-client-token.enum.ts}`                                | `04-catalog-use-cases.md` (write half) + `05-catalog-events.md` (partial)                                        |
| 04  | [Implement `Publish Product` + `Archive Product` use cases](task-04-publish-and-archive-use-cases.md)                                             | `…/application/use-cases/{publish-product,archive-product}.use-case.ts` + specs; event payloads for `ProductPublished`/`ProductArchived`                                                                                                                                                         | `05-catalog-events.md` (complete)                                                                                |
| 05  | [Implement `Query Catalog` read path](task-05-query-catalog-read-path.md)                                                                         | `…/application/use-cases/{list-products,get-product-by-slug,get-variant}.use-case.ts`; `…/presentation/catalog.controller.ts` `@MessagePattern` handlers; RPC routing keys (`catalog.product.list`, `catalog.product.get`, `catalog.variant.get`)                                                | `04-catalog-use-cases.md` (read half appended)                                                                   |
| 06  | [Add the api-gateway `modules/catalog/` module](task-06-api-gateway-catalog-module.md)                                                            | `apps/api-gateway/src/modules/catalog/` (new tree — port + RMQ adapter + use cases + controller + DTOs + pipes); `apps/api-gateway/src/app/app.module.ts`                                                                                                                                        | `06-api-gateway-catalog-module.md`                                                                               |
| 07  | [Author `http/catalog.http`](task-07-kulala-catalog-http-file.md)                                                                                 | `http/catalog.http`                                                                                                                                                                                                                                                                              | `07-kulala-catalog-http-file.md`                                                                                 |
| 08  | [Drop the obsolete inventory-microservice `product` table](task-08-drop-old-inventory-product-table.md)                                           | new migration `DropInventoryProductTable`                                                                                                                                                                                                                                                        | —                                                                                                                |
| 09  | [Seed + documentation pass — README, CLAUDE.md, arch-lint, test seed](task-09-seed-and-documentation-pass.md)                                     | `scripts/test-db-seed.ts`, `README.md`, `CLAUDE.md`, `spec/architecture-lint.spec.ts`                                                                                                                                                                                                            | —                                                                                                                |

## Document-deliverable map

The epic lists seven topic-numbered docs under `docs/implementation/epic-02-catalog-product-and-variant/`. The same doc can be touched by more than one task:

- **`01-new-catalog-microservice-scaffold.md`** — task-01 writes the entire file (Nest CLI generation, monorepo wiring, docker-compose, OTel, eslint boundaries, app-shell layout).
- **`02-product-and-variant-domain.md`** — task-02 writes the entire file (aggregate boundaries, invariants, status state machine).
- **`03-product-and-variant-persistence.md`** — task-02 writes the entire file (entity + mapper + repository shape; FK rationale).
- **`04-catalog-use-cases.md`** — task-03 writes the write-side use-case half (`Register Product`, `Add Variant`, ports + adapters). Task-04 appends the publish/archive subsection. Task-05 appends the read-side subsection (the `@MessagePattern` RPC handlers).
- **`05-catalog-events.md`** — task-03 writes the routing-key registration + payload shapes for `catalog.variant.created`. Task-04 completes the doc with the `catalog.product.published` / `catalog.product.archived` payloads and the `v1` versioning rationale.
- **`06-api-gateway-catalog-module.md`** — task-06.
- **`07-kulala-catalog-http-file.md`** — task-07.

## Cross-epic coupling notes

- **`epic-01`** is a hard prerequisite. Task-04 (api-gateway gating) and task-06 (the gateway catalog controller) rely on `PermissionsGuard`, `@RequiresPermission()`, and the seeded permission codes (`catalog:read`, `catalog:write`, `catalog:publish`). If epic-01's task-04 has not landed, the catalog controller's permission gating cannot be exercised end-to-end; the task assumes epic-01 is merged.
- **`epic-03`** owns the Price precondition for `Publish Product`. Task-04 below enforces "≥1 variant" as a hard rule and treats "≥1 active Price" as a logged warning with a TODO referenced in the spec — the warning becomes an error in `epic-03`.
- **`epic-04`** owns the inventory consumer for `catalog.variant.created` (auto-init `StockLevel = 0` at the default location). This epic only emits the event; it does not bind a consumer. Task-08 (drop old `product` table) also flags that the inventory `stock-typeorm.repository.ts` FK reference is left dangling for `epic-04` to reshape.
- **`epic-06`** owns Category + MediaAsset and the `Reclassify Product` operation. None of those are touched here.

## Self-containment rule

> Outputs produced by these tasks must not reference any path under `tmp/`. The task files themselves live in `tmp/tasks/…` and are scaffolding; the artifacts they produce (entities, migrations, docs, controllers, http files, README/CLAUDE updates) live under `apps/`, `libs/`, `migrations/`, `http/`, `docs/`, `scripts/`, `spec/`, `README.md`, `CLAUDE.md` — and none of those files may cite `tmp/`.

## Exit criteria (all 9 tasks complete)

Mirrors the epic's `Exit Criteria` section. Each task carries its own per-task exit criteria; this is the cumulative gate.

- [ ] `yarn lint` passes (`--max-warnings 0`); the new microservice's boundaries match the existing inventory/retail/notification shapes.
- [ ] `yarn test:unit` passes; ≥6 new domain/use-case spec files green under `apps/catalog-microservice/`.
- [ ] `yarn test:e2e` passes; `test/catalog.e2e-spec.ts` green.
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev` boots all five services (the four existing + `catalog-microservice`); `catalog_queue` is bound on RabbitMQ.
- [ ] Every request in `http/catalog.http` executes end-to-end against the seeded data.
- [ ] `GET /api/catalog/products` returns the two seeded active products with their variants.
- [ ] Per-task docs present under `docs/implementation/epic-02-catalog-product-and-variant/`.
- [ ] `README.md` Services table + System diagram + API section reflect the catalog microservice; `CLAUDE.md` includes the new Catalog microservice section.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`.
