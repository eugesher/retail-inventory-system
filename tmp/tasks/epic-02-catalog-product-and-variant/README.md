---
epic: epic-02
source_epic_file: tmp/epics/epic-02-catalog-product-and-variant.md
---

# epic-02 — Task Index

This epic is decomposed into **10 self-contained tasks**, each sized for a
single cold-start session. Every task file states its **entry state** (what
prior tasks left on disk and in the `retail_db` schema), the **concrete files**
it adds/modifies/deletes, the **tests** it must write, its **doc deliverable**,
and its **exit criteria**. A task assumes nothing about future tasks; it relies
only on the repository as committed by prior tasks plus the `carryover-*.md`
notes in this folder. Run them strictly in order — there is no parallelism.

## Sequence and dependencies

| # | Task | Touches | Doc deliverable |
|---|---|---|---|
| 1 | [Scaffold the catalog microservice](task-01-scaffold-catalog-microservice.md) | `apps/catalog-microservice/`, `nest-cli.json`, `package.json`, `docker-compose.yml`, `scripts/bash/start-dev.sh`, `libs/contracts/microservices/*.enum.ts` | `01-new-catalog-microservice-scaffold.md` |
| 2 | [Remove the inventory `product` stub](task-02-remove-inventory-product-stub.md) | `migrations/`, `apps/inventory-microservice/.../persistence/`, `apps/inventory-microservice/.../stock.module.ts`, `scripts/seeds/`, `scripts/utils/` | `02-inventory-product-stub-removed.md` |
| 3 | [Product + ProductVariant domain](task-03-product-and-variant-domain.md) | `apps/catalog-microservice/src/modules/catalog/domain/` | `03-product-and-variant-domain.md` + **ADR-025** |
| 4 | [Product + ProductVariant persistence](task-04-product-and-variant-persistence.md) | `apps/catalog-microservice/.../infrastructure/persistence/`, `apps/catalog-microservice/.../catalog.module.ts`, `migrations/` | `04-product-and-variant-persistence.md` |
| 5 | [Register Product + Add Variant use cases](task-05-register-and-add-variant-use-cases.md) | `apps/catalog-microservice/.../application/`, `apps/catalog-microservice/.../presentation/`, `libs/messaging/`, `libs/contracts/catalog/`, `libs/contracts/microservices/` | `05-catalog-use-cases.md` (start) + `06-catalog-events.md` (start) |
| 6 | [Publish Product + Archive Product use cases](task-06-publish-and-archive-use-cases.md) | `apps/catalog-microservice/.../application/`, `apps/catalog-microservice/.../presentation/`, `libs/messaging/`, `libs/contracts/catalog/`, `libs/contracts/microservices/` | `06-catalog-events.md` (complete) + `05-catalog-use-cases.md` (extend) |
| 7 | [Query Catalog read path](task-07-query-catalog-read-path.md) | `apps/catalog-microservice/.../application/`, `apps/catalog-microservice/.../presentation/`, `libs/messaging/`, `libs/contracts/catalog/`, `libs/cache/cache-keys.ts` | `05-catalog-use-cases.md` (read section) |
| 8 | [API-gateway catalog module](task-08-api-gateway-catalog-module.md) | `apps/api-gateway/src/modules/catalog/`, `apps/api-gateway/src/app/app.module.ts`, `test/catalog.e2e-spec.ts` | `07-api-gateway-catalog-module.md` |
| 9 | [Kulala `http/catalog.http`](task-09-kulala-catalog-http-file.md) | `http/catalog.http` | `08-kulala-catalog-http-file.md` |
| 10 | [Seed + docs + lint-fixtures finalization](task-10-seed-and-docs-finalization.md) | `scripts/seeds/`, `scripts/utils/`, `spec/architecture-lint.spec.ts`, `README.md`, `CLAUDE.md` | README + CLAUDE.md (no new numbered doc) |

## Carryover chain

Each task `NN` ends by writing `carryover-NN.md` in this folder. Each task `N`
begins by reading **every** prior `carryover-01.md … carryover-(N-1).md` in
order. The carryover files are the only transition markers and live only under
this folder — never in source, docs, `README.md`, or `CLAUDE.md`. Do the tasks
in order; do not parallelize.

## Document-deliverable map

Implementation docs live under `docs/implementation/02-catalog-product-and-variant/`.
Each task writes its own doc(s) **as part of its Definition of Done** (a task is
not complete until its doc explains the what and why) — the final task does not
back-fill earlier docs.

| Doc | Written by |
|---|---|
| `01-new-catalog-microservice-scaffold.md` | task-01 |
| `02-inventory-product-stub-removed.md` | task-02 |
| `03-product-and-variant-domain.md` | task-03 |
| `04-product-and-variant-persistence.md` | task-04 |
| `05-catalog-use-cases.md` | task-05 (create) → task-06 (extend) → task-07 (read-path section) |
| `06-catalog-events.md` | task-05 (start) → task-06 (complete) |
| `07-api-gateway-catalog-module.md` | task-08 |
| `08-kulala-catalog-http-file.md` | task-09 |

**ADR:** task-03 records **ADR-025** (`docs/adr/025-catalog-product-and-variant-aggregate.md`)
— the catalog bounded context, the Product/ProductVariant aggregate shape, and
the `variantId` backbone. No other task introduces an ADR; no task may violate
an accepted ADR.

**README.md + CLAUDE.md** are updated by task-10 (the final pass). The
`spec/architecture-lint.spec.ts` regression fixtures are also extended in
task-10.

## Self-containment rule

No file under `docs/`, `apps/`, `libs/`, `http/`, `scripts/`, `spec/`,
`migrations/`, `README.md`, or `CLAUDE.md` may reference any path under `tmp/`,
or use the words "epic"/"task" as names for this planning process. Forward work
is described by capability (e.g. "a later pricing capability"), never by an
epic/task number.

## Cumulative exit criteria (gate for "all tasks complete")

- [ ] `yarn lint` passes (`--max-warnings 0`); the catalog microservice's
      boundaries match the existing inventory/retail/notification shapes.
- [ ] `yarn test:unit` passes; ≥6 new catalog domain/use-case spec files green.
- [ ] `yarn test:e2e` passes; `test/catalog.e2e-spec.ts` green.
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev` boots all
      five services (the four existing + `catalog-microservice`); `catalog_queue`
      is bound on RabbitMQ.
- [ ] The inventory `product` table and `product.entity.ts` are gone before the
      catalog `product` table is created; `yarn migration:run` applies cleanly
      end-to-end with no table-name collision in the shared `retail_db` schema.
- [ ] Every request in `http/catalog.http` executes end-to-end against seeded data.
- [ ] `GET /api/catalog/products` returns the two seeded active products with
      their variants.
- [ ] Per-topic docs present under `docs/implementation/02-catalog-product-and-variant/`.
- [ ] `README.md` Services table + System diagram + API section reflect the
      catalog microservice; `CLAUDE.md` includes the new Catalog microservice section.
- [ ] The self-containment grep is clean across `docs/`, `apps/`, `libs/`,
      `http/`, `scripts/`, `spec/`, `migrations/`, `README.md`, `CLAUDE.md`.
