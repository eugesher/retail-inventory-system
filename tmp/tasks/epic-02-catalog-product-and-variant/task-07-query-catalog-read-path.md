---
epic: epic-02
task_number: 7
title: Query Catalog read path
depends_on: [task-01, task-02, task-03, task-04, task-05, task-06]
doc_deliverable: docs/implementation/02-catalog-product-and-variant/05-catalog-use-cases.md
adr_deliverable: none
---

# Task 07 — Query Catalog read path

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the `docs/adr/` documents related to this task.

Most relevant ADRs: **ADR-008 + ADR-020** (RPC routing keys; `@MessagePattern`),
**ADR-016 + ADR-022** (cache-key convention + per-aggregate schema-version
constant — this task adds the reserved catalog builder), **ADR-004 / ADR-017**
(boundaries), **ADR-005** (pagination types `IPage` / `IPageRequest` live in
`@retail-inventory-system/common`).

## Goal

Implement the Customer-facing read path: list active products (paged, with their
active variants), fetch a product by slug, and fetch a single variant by id. Add
the RPC routing keys + read contracts + `@MessagePattern` handlers. Also add the
reserved (currently-unused) catalog cache-key builder + version constant so a
future cached read path can adopt it without re-keying.

## Entry state assumed

- task-01–06 carryover present. All four write operations work end-to-end on the
  catalog side; the publisher seam + `libs/contracts/catalog/` exist; the
  controller handles the four write commands.
- `ROUTING_KEYS` has the write/event keys but **no** read keys.
- `libs/cache/cache-keys.ts` has `CACHE_KEYS` with inventory/retail builders and
  the `INVENTORY_STOCK_KEY_VERSION` / `RETAIL_ORDER_KEY_VERSION` constants — no
  catalog builder yet. The catalog service does **not** import `CacheModule`.

## Scope

**In**

- `ListProductsUseCase`, `GetProductBySlugUseCase`, `GetVariantUseCase` + specs.
- RPC read routing keys (mirror + assert).
- Read contracts (query + paginated response views).
- `@MessagePattern` read handlers on `catalog.controller.ts`.
- The reserved `CACHE_KEYS.catalogProduct*` builder + `CATALOG_PRODUCT_KEY_VERSION`
  + a cache-keys spec assertion. **Builder only — not consumed** by this work.

**Out**

- Wiring `CacheModule` / actually caching reads — the builder is reserved for a
  future cached read path; do not import `CacheModule` into the catalog service.
- The gateway HTTP endpoints (task-08).

## Routing keys (add + mirror + assert)

| `ROUTING_KEYS` member | wire value |
|---|---|
| `CATALOG_PRODUCT_LIST` | `catalog.product.list` |
| `CATALOG_PRODUCT_GET` | `catalog.product.get` |
| `CATALOG_VARIANT_GET` | `catalog.variant.get` |

Add each to `ROUTING_KEYS` + `MicroserviceMessagePatternEnum`, with equality
assertions in `libs/messaging/spec/routing-keys.constants.spec.ts`.

## Read contracts (`libs/contracts/catalog/`)

- `IListProductsQuery` — `{ status?: 'active' | 'draft' | 'archived'; page?: number; pageSize?: number; search?: string; correlationId }`.
  Default `status` to `active` on the read side (browse hides non-active).
- `IGetProductBySlugQuery` — `{ slug: string; correlationId }`.
- `IGetVariantQuery` — `{ variantId: number; correlationId }`.
- Response views (reuse `ProductView` / `ProductVariantView` from task-05):
  - List → `IPage<ProductWithVariantsView>` where `ProductWithVariantsView =
    ProductView & { variants: ProductVariantView[] }` (active variants only).
  - Get-by-slug → `ProductWithVariantsView` (full product + its active variants).
  - Get-variant → `ProductVariantView & { product: ProductView }` (variant +
    parent product header).
  Use `IPage` / `IPageRequest` from `@retail-inventory-system/common` for the
  paginated shape (mirror how retail/inventory paginate).

## Use cases (`application/use-cases/`)

- `ListProductsUseCase` — repository `listActive(pageRequest, search?)` filtered
  to `status=active` (and each product's `active` variants); returns an `IPage`.
- `GetProductBySlugUseCase` — `findBySlug`; returns the product + active variants;
  not-found → RPC error. (A product is resolvable by slug regardless of status so
  historical references stay valid, but browse/list only surfaces `active` — keep
  the list filter and the by-slug fetch distinct.)
- `GetVariantUseCase` — `findVariantById`; returns the variant + its parent
  product header; not-found → RPC error. An **archived** variant/product stays
  resolvable here (historical order/stock references must never dangle).

## Reserved cache-key builder (ADR-016 / ADR-022)

In `libs/cache/cache-keys.ts`:

- Add `const CATALOG_PRODUCT_KEY_VERSION = 'v1';` next to the existing version
  constants.
- Add to `CACHE_KEYS`:
  - `catalogProductPrefix: (variantId: number, opts?) => \`${rootPrefix(opts)}catalog:product:${CATALOG_PRODUCT_KEY_VERSION}:${variantId}:\``
  - `catalogProduct: (variantId: number, opts?) => \`${CACHE_KEYS.catalogProductPrefix(variantId, opts)}${ALL_FACETS_SENTINEL}\``
- Key on **`variantId`** (the downstream backbone, per ADR-025), not `productId`.
- Add an assertion to `libs/cache/spec/cache-keys.spec.ts` locking the literal
  `ris:catalog:product:v1:<id>:__all__` (and the tenant-prefixed variant). Note
  in a comment that the builder is reserved for a future cached catalog read path
  and is not consumed yet.

## Presentation handlers

Add to `catalog.controller.ts`:
- `@MessagePattern(ROUTING_KEYS.CATALOG_PRODUCT_LIST)` → `ListProductsUseCase`.
- `@MessagePattern(ROUTING_KEYS.CATALOG_PRODUCT_GET)` → `GetProductBySlugUseCase`.
- `@MessagePattern(ROUTING_KEYS.CATALOG_VARIANT_GET)` → `GetVariantUseCase`.

Register the three read use cases in `catalog.module.ts`.

## Files to add

- `apps/catalog-microservice/src/modules/catalog/application/use-cases/list-products.use-case.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/get-product-by-slug.use-case.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/get-variant.use-case.ts`
- Read query/view contracts under `libs/contracts/catalog/`.
- Use-case specs (see Tests).

## Files to modify

- `libs/messaging/routing-keys.constants.ts`
- `libs/messaging/spec/routing-keys.constants.spec.ts`
- `libs/contracts/microservices/microservice-message-pattern.enum.ts`
- `libs/contracts/catalog/` (barrel + read contracts)
- `libs/cache/cache-keys.ts`
- `libs/cache/spec/cache-keys.spec.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/index.ts`
- `apps/catalog-microservice/src/modules/catalog/presentation/catalog.controller.ts`
- `apps/catalog-microservice/src/modules/catalog/catalog.module.ts`
- The repository adapter, if `listActive` / `findBySlug` / `findVariantById`
  need read-side query refinement beyond task-04's stubs.

## Files to delete

- None.

## Tests

- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/list-products.use-case.spec.ts`
  — returns only `active` products with their `active` variants; pagination shape;
  `search` filter passed through.
- Specs for `get-product-by-slug` and `get-variant` — happy path + not-found
  (and: an archived product/variant is still returned by the by-slug/by-id fetch).
- The cache-keys spec assertion for the catalog builder.
- The routing-keys spec assertions for the three read keys.
- `yarn test:e2e` stays green (gateway endpoints arrive in task-08).

## Doc deliverable

Extend `docs/implementation/02-catalog-product-and-variant/05-catalog-use-cases.md`
with the read-path section: the three read use cases, the list-filters-on-active
vs resolvable-by-id distinction, the pagination shape, and the reserved catalog
cache-key builder (keyed on `variantId`, version `v1`, not yet consumed) with the
ADR-016/022 rationale.

## Carryover to read

`carryover-01.md` … `carryover-06.md`.

## Carryover to produce

Write `carryover-07.md` capturing: the three read routing keys + mirror; the read
contracts + view shapes; the three read use cases + their `@MessagePattern` keys
(the catalog side now handles all seven RPC patterns: register, variant.create,
publish, archive, product.list, product.get, variant.get); the reserved
`CACHE_KEYS.catalogProduct*` builder + `CATALOG_PRODUCT_KEY_VERSION`; doc 05
read-path section written; verification commands.

## Exit criteria

- [ ] `ListProductsUseCase`, `GetProductBySlugUseCase`, `GetVariantUseCase` exist
      with specs (active-only list; archived still resolvable by id/slug).
- [ ] The three read routing keys exist in `ROUTING_KEYS` +
      `MicroserviceMessagePatternEnum` and are asserted in the spec.
- [ ] The catalog controller handles all seven RPC patterns.
- [ ] `CACHE_KEYS.catalogProduct*` + `CATALOG_PRODUCT_KEY_VERSION` exist and are
      asserted in the cache-keys spec; the catalog service still does not import
      `CacheModule`.
- [ ] `yarn lint` passes (`--max-warnings 0`); `yarn test:unit` passes;
      `yarn test:e2e` passes.
- [ ] Doc 05 has the read-path section.
- [ ] The self-containment grep is clean:
      `grep -rniE 'tmp/|\bepic\b|\btask\b' docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md`.
- [ ] `carryover-07.md` is written.
