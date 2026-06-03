---
id: epic-02
title: Catalog foundation — Product + ProductVariant in a new catalog microservice
source_stages: [walking-skeleton]
depends_on: [epic-01]
microservices: [api-gateway, catalog-microservice]
task_subfolder: tmp/tasks/epic-02-catalog-product-and-variant/
docs_subfolder: docs/implementation/02-catalog-product-and-variant/
---

# Epic 02 — Catalog foundation — Product + ProductVariant in a new catalog microservice

## Goal

Stand up a brand-new `catalog-microservice` whose single `catalog` bounded context owns the merchandisable graph: `Product` (the abstract good) 1→N `ProductVariant` (the sellable, stocked, priced unit). Every downstream cluster keys on `variantId` — inventory's `StockLevel`, pricing's `Price`, retail's `OrderLine`/`CartLine`. The new microservice replaces the inventory-microservice's tiny `product` stub and is the source of truth for catalog reads and writes. Implement the four Stage-1 catalog operations the report names: Register Product, Add Variant, Publish Product, Archive Product, plus the Customer-facing Query Catalog read path.

## In-Scope Entities and Operations

- **Product**: `id`, `name`, `slug` (unique), `description`, `status` (draft | active | archived), `createdAt`, `updatedAt`.
- **ProductVariant**: `id`, `productId`, `sku` (globally unique), `gtin` (optional), `optionValues` (JSON map: e.g. `{ color: 'red', size: 'M' }`), `weight` (grams, integer), `dimensions` (`{ l, w, h }` in mm, optional), `status` (active | archived), `createdAt`, `updatedAt`.
- **Operations (report verbatim):**
  - **Register Product** (User; `catalog:write`) — new Product in `draft`, no variants.
  - **Add Variant** (User; `catalog:write`) — append a Variant under a Product; `sku` globally unique; emits `VariantCreated`. **Cross-domain hook:** auto-initialize `StockLevel = 0` at the default location is owned by `epic-04` (this epic emits the `VariantCreated` event; epic-04 wires the inventory consumer).
  - **Publish Product** (User; `catalog:publish`) — draft → active; preconditions: ≥1 variant; ≥1 active Price (the Price precondition is enforced post-`epic-03` — until then the publish path warns but does not block on missing Price); emits `ProductPublished`.
  - **Archive Product** (User; `catalog:write`) — active → archived; product hidden from browse but still referenceable from historical Orders. Emits `ProductArchived`.
  - **Query Catalog** (Customer; public) — read-only browse: list active products + their active variants, page-able by slug or name.

## Non-Goals

- **Category** and **MediaAsset** — owned by `epic-06` (Stage 2 catalog extensions).
- **Price** and **TaxCategory** — owned by `epic-03`. Until that lands, the publish precondition "≥1 active Price" is enforced as a warning, not a hard rule.
- **Auto-initialize `StockLevel = 0` on `VariantCreated`** — the catalog side emits the event; the inventory consumer is owned by `epic-04`.
- **Reclassify Product** (Category attach/detach) — owned by `epic-06` (depends on Category existing).
- **Per-attribute typed Product Types / dynamic attribute schemas** — Exclusions Register (owned by `epic-15`).
- **Product bundles / kits, configurable products with option dependencies, digital good entitlements, brand entity, supplier/vendor, multi-locale translation tables** — Exclusions Register (owned by `epic-15`).

## Architectural Decisions Honored

- **Cross-Cutting "Soft delete vs hard delete":** Product and ProductVariant are soft-delete entities (use the `status` field; never `deletedAt`). Historical OrderLines and StockMovements may still reference an archived variant by id — the row must stay resolvable forever.
- **Cross-Cutting "Event emission":** `ProductPublished`, `ProductArchived`, `VariantCreated` are mandatory state-transition events. Versioned by event type from day one (`v1` suffix in the routing-key/payload contract).
- **Cross-Cutting "Auditability":** catalog edits are versioned (via the event stream + the immutable Order snapshot on the buyer side); per-row audit-log fidelity is **not** required for catalog — only for staff IAM, prices, orders, fulfillment, refunds, stock movements.
- **ADR-004 / 009 / 012 / 013** (per-module hexagonal): the new microservice's single `catalog` bounded context follows the canonical per-module template (modeled on `apps/notification-microservice/src/modules/notifications/`). `domain/application/infrastructure/presentation` split is non-negotiable.
- **ADR-008 + ADR-020** (RabbitMQ wiring + dotted routing keys): new routing keys `catalog.product.published`, `catalog.product.archived`, `catalog.variant.created` go into `libs/messaging/routing-keys.constants.ts`. A new `MicroserviceClientCatalogModule` is added to `libs/messaging/`.
- **ADR-009** (port-and-adapter at the gateway): the api-gateway's new `modules/catalog/` follows the existing `retail/` and `inventory/` shape — `CatalogGatewayPort` lives in `application/ports/`; `ClientProxy` is confined to `infrastructure/messaging/catalog-rabbitmq.adapter.ts`.
- **ADR-016 + ADR-022** (cache keys + schema version): if a future cached-catalog read path is added, the key convention is `ris:catalog:product:v1:<variantId>[:<facet>]` (builder added to `libs/cache/cache-keys.ts` even though this epic does not consume it; the constant `CATALOG_PRODUCT_KEY_VERSION = 'v1'` is introduced for future epics to bump).
- **ADR-017** (architecture lint): the new `catalog-microservice` is added to the `eslint.config.mjs` boundaries config (a new `app: 'catalog-microservice'` entry and corresponding rules); the fixture suite `spec/architecture-lint.spec.ts` is extended.
- **ADR-018** (NestJS monorepo apps + libs): the new microservice is added to `nest-cli.json` (`projects` map) and to `package.json` (`start:dev:catalog-microservice`, `build:catalog-microservice`, etc.), and to `docker-compose.yml` + OTel collector config.
- **ADR-019** (TypeORM + MySQL): new tables go through a fresh migration; `BaseEntity` + `SnakeNamingStrategy` apply.
- **ADR-010** (JWT + RBAC at the gateway): all write endpoints sit behind `@RequiresPermission('catalog:write')` or `@RequiresPermission('catalog:publish')` (codes seeded by `epic-01`); read endpoints are `@Public()`.

## Persistence Changes

**Added (in the new catalog-microservice):**

- `product` table: `id` (INT PK), `name`, `slug` (unique), `description`, `status` (enum), timestamps.
- `product_variant` table: `id` (INT PK), `product_id` (FK), `sku` (unique), `gtin` (nullable), `option_values` (JSON), `weight_g` (INT nullable), `dimensions_mm` (JSON nullable), `status` (enum), timestamps.

**Removed (in the conflict-resolution cleanup — task 2, before any catalog table is created):**

- The inventory-microservice's existing `product` table (3 columns: `id`, `name`, timestamps) is **dropped**, together with its entity (`apps/inventory-microservice/src/modules/stock/infrastructure/persistence/product.entity.ts`), the barrel re-export in that folder's `index.ts`, its TypeORM entity registration, and any FK constraint referencing it. **This must happen before task 3 creates the catalog `product` table** — both live in the single shared `retail_db` schema, so a catalog `CREATE TABLE product` would collide with the inventory stub otherwise. The inventory `product_stock.product_id` column is kept as a plain integer (no FK) until `epic-04` reshapes the inventory model onto `variantId`; nothing is left dangling against a dropped table.
- The retail-microservice does NOT own a `product` table today; no removal there.

**Indexes & constraints:**

- Unique index on `product.slug`, `product_variant.sku`, `product_variant.gtin` (the GTIN unique index is partial / nullable-aware on engines that support it; otherwise a regular index).
- FK `product_variant.product_id → product.id ON DELETE RESTRICT` (cannot delete a Product that has variants — archival is the path).
- No `version` column on Product/ProductVariant at this stage (last-writer-wins is acceptable per Cross-Cutting §1; catalog is not in the no-oversell critical path).

## Eventing / Messaging

- **New routing keys (added to `libs/messaging/routing-keys.constants.ts`):**
  - `catalog.product.published` — emitted on draft→active; payload: `{ productId, slug, variantIds: number[], publishedAt, eventVersion: 'v1', correlationId }`.
  - `catalog.product.archived` — emitted on active→archived; payload: `{ productId, archivedAt, eventVersion: 'v1', correlationId }`.
  - `catalog.variant.created` — emitted on Add Variant; payload: `{ productId, variantId, sku, eventVersion: 'v1', correlationId }`.
- **New queue:** `catalog_queue` (RPC + events binding) for catalog-microservice's RPC handlers (the read-path `catalog.product.get`, `catalog.variant.get`).
- **New `MicroserviceClientCatalogModule`** in `libs/messaging/` — mirrors the existing `MicroserviceClientRetail/Inventory/NotificationModule`.
- **No new exchange** is created — events ride the default exchange today (per the current `notification_events` pattern); the reserved `notification` exchange constant in `libs/messaging/exchanges.constants.ts` is unaffected.
- **Correlation-id propagation** flows via the AMQP-headers convention already established by `libs/observability/correlation.types.ts`; nothing new required.

## API Surface

**New / modified HTTP endpoints in `api-gateway`** (all under the new `modules/catalog/` module):

| Method | Path | Body / params | Auth | Response |
|---|---|---|---|---|
| `POST` | `/api/catalog/products` | `{ name, slug, description }` | bearer + `catalog:write` | `{ id, name, slug, description, status: 'draft' }` |
| `POST` | `/api/catalog/products/:productId/variants` | `{ sku, gtin?, optionValues, weightG?, dimensionsMm? }` | bearer + `catalog:write` | `{ id, productId, sku, … }` |
| `POST` | `/api/catalog/products/:productId/publish` | — | bearer + `catalog:publish` | `{ id, status: 'active', publishedAt }` |
| `POST` | `/api/catalog/products/:productId/archive` | — | bearer + `catalog:write` | `{ id, status: 'archived', archivedAt }` |
| `GET` | `/api/catalog/products` | query: `?status=active&page=…&pageSize=…&search=…` | `@Public()` | paginated list of products with their variants |
| `GET` | `/api/catalog/products/:slug` | — | `@Public()` | full product + its active variants |
| `GET` | `/api/catalog/variants/:variantId` | — | `@Public()` | single variant including parent product header |

**Kulala HTTP files** (under `http/`):

- **`http/catalog.http`** — NEW; every endpoint above with a representative payload, cited controller paths in header comments, and a `# Prereqs:` block describing the seeded admin login flow + capturing the access token in an `@accessToken` variable.

## Test Strategy

**Unit tests** (domain spec siblings):

- `apps/catalog-microservice/src/modules/catalog/domain/spec/product.model.spec.ts` — slug-uniqueness invariant (enforced at the repository, asserted via test double), status transitions (draft→active→archived, no draft←archived), publish precondition (≥1 variant; the Price precondition is a TODO referenced in the spec and enforced once `epic-03` lands).
- `apps/catalog-microservice/src/modules/catalog/domain/spec/product-variant.model.spec.ts` — sku uniqueness invariant (repository-level), `optionValues` is a non-empty map, weight non-negative.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/register-product.use-case.spec.ts` — happy path + duplicate-slug-rejected.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/add-variant.use-case.spec.ts` — happy path + duplicate-sku-rejected + parent-not-found-rejected + emits `VariantCreated`.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/publish-product.use-case.spec.ts` — happy path + no-variants-rejected + emits `ProductPublished`.
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/archive-product.use-case.spec.ts` — happy path + emits `ProductArchived`.

**E2E tests** (through api-gateway):

- `test/catalog.e2e-spec.ts`:
  1. Admin registers a Product (returns draft).
  2. Admin adds two Variants.
  3. Admin publishes the Product (returns active).
  4. Customer queries `/api/catalog/products` and sees the new Product with both Variants.
  5. Admin archives the Product (returns archived).
  6. Customer queries again and the Product no longer appears in the default (status=active) filter.
  7. Permission tests: non-`catalog:write` user gets `403` on POST; non-`catalog:publish` user gets `403` on publish; unauthenticated user gets `200` on the public GETs.

**Concurrency tests:** N/A at this stage (catalog mutations are last-writer-wins).

**Seed data required:**

- `scripts/test-db-seed.ts` extended to also seed the new permissions (`catalog:read`, `catalog:write`, `catalog:publish`) into the seeded roles (`catalog-manager` gets all three; `admin` already has them via `epic-01`).
- Seed two example products with two variants each, in `active` status, so that subsequent epics can address them by id without each epic re-seeding.

## Documentation Deliverables

**Per-task markdown files** under `docs/implementation/02-catalog-product-and-variant/`:

- `01-new-catalog-microservice-scaffold.md` — Nest CLI generation, `nest-cli.json` / `package.json` / `docker-compose.yml` / OTel-collector wiring, `eslint.config.mjs` boundaries update, MessagingModule + DatabaseModule + LoggerModule + tracer first-import.
- `02-inventory-product-stub-removed.md` — why the inventory-side `product` stub is removed up front (single shared `retail_db` schema → the catalog `product` table cannot be created while the stub exists); what was dropped (table, entity, barrel re-export, entity registration, FK); why `product_stock.product_id` is left as a plain integer until `epic-04`.
- `03-product-and-variant-domain.md` — aggregate boundaries (Product is the aggregate root; ProductVariant is a child entity inside Product on writes but a top-level read entity), invariants, status state machine.
- `04-product-and-variant-persistence.md` — entity + mapper + repository shape; FK rationale.
- `05-catalog-use-cases.md` — Register / Add Variant / Publish / Archive use cases, ports and adapters used.
- `06-catalog-events.md` — routing keys added, payload shapes, version `v1` rationale.
- `07-api-gateway-catalog-module.md` — gateway module mirrors retail/inventory shape; permission gating decisions.
- `08-kulala-catalog-http-file.md` — the `http/catalog.http` shape and how to run it locally.

**`README.md` updates required:**

- Add a `catalog-microservice` row to the **Services** table.
- Update the **System diagram** to include the catalog box and its `catalog_queue`; show the new routing keys.
- Remove the inventory-microservice's `product` box/table from the **System diagram** and any prose describing it — it is dropped in task 2.
- Add **API → Catalog** section with the endpoint list.
- Add a new diagram caption noting "every downstream cluster keys on `variantId` (not `productId`)".

**`CLAUDE.md` updates required:**

- Add `apps/catalog-microservice/` to the Architecture section's app tree.
- Add a new section **Catalog microservice (`apps/catalog-microservice/src/`)** mirroring the per-module template documentation block (modeled on the notification + inventory + retail sections).
- Add the new routing keys to the **Message patterns** list.
- Update the **Shared Libraries → messaging** description to mention `MicroserviceClientCatalogModule`.

**Exclusions Register documents owned by this epic:** None (all under `epic-15`).

## Tasks (decomposition hint)

1. **Scaffold the new catalog-microservice.** Nest generate, wire `nest-cli.json`, `package.json` scripts, `docker-compose.yml`, OTel collector, tracer-first-import, LoggerModule, MessagingModule, DatabaseModule, eslint boundaries config + fixture suite extension.
2. **Resolve naming conflicts — remove the inventory-microservice's `product` stub.** Drop the inventory `product` table via a migration; delete `product.entity.ts`; remove its barrel re-export and TypeORM entity registration; drop any FK constraint referencing it (keep `product_stock.product_id` as a plain integer until `epic-04`). Runs **before** task 3 so the catalog `product` table can be created in the shared `retail_db` schema without a name collision. Complete removal — no rename to a `legacy`/`old` table.
3. **Add Product + ProductVariant domain + persistence + repository port/adapter.** Specs alongside. Creates the catalog `product` + `product_variant` tables.
4. **Implement Register Product + Add Variant use cases.** Specs + event publisher port + RMQ publisher adapter (RoutingKeys + queue + events).
5. **Implement Publish Product + Archive Product use cases.** Specs + event emission.
6. **Implement Query Catalog read path** (RPC handlers + presentation `@MessagePattern` handlers).
7. **Add the api-gateway `modules/catalog/` module.** Port + RMQ adapter + use cases + controller + DTOs + pipes.
8. **Author `http/catalog.http`.**
9. **Seed and documentation pass:** extend `scripts/test-db-seed.ts`; write the per-task `docs/implementation/.../*.md` files; update `README.md` + `CLAUDE.md`; extend `spec/architecture-lint.spec.ts`.

## Carryover Between Tasks

| Task | Entry state assumed | Carryover artifacts produced (never under `tmp/`) |
|---|---|---|
| 1 | `epic-01` complete (StaffUser + Permissions present and gated). | New `apps/catalog-microservice/src/{main,app/app.module}.ts`, updated `nest-cli.json`, `package.json`, `docker-compose.yml`, `infrastructure/otel-collector-config.yaml`, `eslint.config.mjs`, `spec/architecture-lint.spec.ts`; `docs/implementation/02-…/01-…md`. |
| 2 | Task 1 carryover present; the new app boots empty. | A migration dropping the inventory-microservice `product` table (and any FK referencing it); deleted `product.entity.ts` + its barrel re-export + entity registration; `product_stock.product_id` retained as a plain integer column; `docs/implementation/02-…/02-…md`. After this task the shared `retail_db` schema has no `product` table, so task 3 can create the catalog one. |
| 3 | Tasks 1–2 carryover present. | `product.model.ts`, `product-variant.model.ts`, value-objects, entities, mappers, `CatalogTypeormRepository`; new migration creating `product` + `product_variant`; specs; `03-…md`, `04-…md`. |
| 4 | Tasks 1–3 carryover present. | `register-product.use-case.ts`, `add-variant.use-case.ts`, specs, ports + adapters; routing-key constants + queue + `MicroserviceClientCatalogModule`; `05-…md`, `06-…md` (partial). |
| 5 | Tasks 1–4 carryover present. | `publish-product.use-case.ts`, `archive-product.use-case.ts`, specs, additional event emission; `06-…md` complete. |
| 6 | Tasks 1–5 carryover present. | RPC routing keys (`catalog.product.get`, `catalog.variant.get`); presentation `catalog.controller.ts` `@MessagePattern` handlers; `05-…md` updated. |
| 7 | Tasks 1–6 carryover present. | `apps/api-gateway/src/modules/catalog/` full per-module hexagonal layout + controller + DTOs + pipes; `07-…md`. |
| 8 | Task 7 carryover present. | New `http/catalog.http`; `08-…md`. |
| 9 | All prior tasks complete. | Updated `scripts/test-db-seed.ts`, `README.md`, `CLAUDE.md`, `spec/architecture-lint.spec.ts` fixtures; `docs/implementation/02-…/` complete. |

## Exit Criteria

- [ ] `yarn lint` passes (`--max-warnings 0`); the new microservice's boundaries match the existing inventory/retail/notification shapes.
- [ ] `yarn test:unit` passes; ≥6 new domain/use-case spec files green.
- [ ] `yarn test:e2e` passes; `test/catalog.e2e-spec.ts` green.
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev` boots all five services (the four existing + `catalog-microservice`); `catalog_queue` is bound on RabbitMQ.
- [ ] The inventory-microservice's `product` table and `product.entity.ts` are gone before the catalog `product` table is created; `yarn migration:run` applies cleanly end-to-end with no table-name collision in the shared `retail_db` schema.
- [ ] Every request in `http/catalog.http` executes end-to-end against the seeded data.
- [ ] `GET /api/catalog/products` returns the two seeded active products with their variants.
- [ ] Per-task docs present under `docs/implementation/02-catalog-product-and-variant/`.
- [ ] `README.md` Services table + System diagram + API section reflect the catalog microservice; `CLAUDE.md` includes the new Catalog microservice section.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`.

## Self-Containment Notice

> Tasks generated from this epic must produce outputs that contain no references to anything under `tmp/`. The orchestration scratch space is not part of the final deliverable.
