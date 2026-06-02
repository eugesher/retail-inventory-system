# Carryover 07 → task-08

Task-07 ("Query Catalog read path") is complete. This note is the entry state for
task-08 (the API gateway catalog module).

## Entry state for task-08

- The catalog microservice now **handles all seven RPC patterns** (4 write
  commands + 3 read queries) and still emits its three events. It boots clean
  against a live MySQL + RabbitMQ (verified: `Catalog Microservice is listening
  for messages`, no DI errors).
- `catalog.controller.ts` has `@MessagePattern` handlers for: `catalog.product.register`,
  `catalog.variant.create`, `catalog.product.publish`, `catalog.product.archive`,
  **`catalog.product.list`, `catalog.product.get`, `catalog.variant.get`**.
- `catalog.module.ts` registers all seven use cases (the four write +
  `ListProductsUseCase`, `GetProductBySlugUseCase`, `GetVariantUseCase`). The
  repository + events-publisher bindings are unchanged. **Still no `CacheModule`**
  (verified: zero `@retail-inventory-system/cache` references in the catalog app).
- All gates green on a fresh run: `yarn lint` (exit 0, `--max-warnings 0`),
  `yarn test:unit` (**371 passed**, 55 suites — was 358/52; +10 read use-case
  tests across 3 new spec files, +3 routing-key equality assertions in the
  existing routing-keys suite, +3 cache-keys assertions in the existing
  cache-keys suite), `yarn build` (5 apps), `yarn test:e2e` (5 suites / 55 tests /
  38 snapshots — unchanged; the catalog gateway endpoints arrive in task-08),
  self-containment grep clean.

## Three new read routing keys (+ legacy-enum mirror + spec)

Added to `ROUTING_KEYS` (`libs/messaging/routing-keys.constants.ts`) **and** the
identical members to `MicroserviceMessagePatternEnum`
(`libs/contracts/microservices/microservice-message-pattern.enum.ts`); the
routing-keys spec asserts equality for each (the dotted-regex loop covers them):

| `ROUTING_KEYS` member | wire value | kind |
|---|---|---|
| `CATALOG_PRODUCT_LIST` | `catalog.product.list` | RPC query |
| `CATALOG_PRODUCT_GET` | `catalog.product.get` | RPC query |
| `CATALOG_VARIANT_GET` | `catalog.variant.get` | RPC query |

The catalog now owns **10 keys total** (4 write commands, 3 events, 3 read
queries).

## Read contracts (`libs/contracts/catalog/`)

- `interfaces/list-products.interface.ts` — `IListProductsQuery` (`{ status?:
  'active'|'draft'|'archived'; page?: number; pageSize?: number; search?: string }`
  + `correlationId` via `ICorrelationPayload`). `status` defaults to `active` on
  the contract; the read path serves the active catalogue today (the field is
  reserved for a future non-active browse).
- `interfaces/get-product-by-slug.interface.ts` — `IGetProductBySlugQuery`
  (`{ slug: string }` + `correlationId`).
- `interfaces/get-variant.interface.ts` — `IGetVariantQuery` (`{ variantId:
  number }` + `correlationId`).
- `dto/product-with-variants.view.ts` — `ProductWithVariantsView extends
  ProductView` with `variants: ProductVariantView[]` (**active variants only**).
- `dto/variant-with-product.view.ts` — `VariantWithProductView extends
  ProductVariantView` with `product: ProductView`.
- `dto/page.view.ts` — **`IPage<T>`** generic envelope `{ items, total, page,
  size }`. **DEVIATION (must respect):** the canonical `IPage<T>` /
  `IPageRequest` live in `@retail-inventory-system/common` (ADR-005), but the
  boundaries lint (ADR-017, `eslint.config.mjs:219`) keeps `lib-contracts`
  importing **only** `lib-contracts`, and the gateway-facing `presentation` layer
  that names the response type can reach `lib-contracts` but not `lib-common`. So
  the wire contract **re-declares the identical shape locally** in
  `libs/contracts/catalog/dto/page.view.ts` — the same local-declaration pattern
  the repository port uses for its internal `IProductPage` (carryover-04). Do not
  try to import common's `IPage` into the contracts or the controller — it fails
  `yarn lint`.
- Barrels updated: `dto/index.ts`, `interfaces/index.ts` (the catalog barrel +
  the top-level contracts barrel already re-export `./catalog`).

Response shapes:
- `catalog.product.list` → `IPage<ProductWithVariantsView>` (active products,
  active variants).
- `catalog.product.get` → `ProductWithVariantsView` (product of any status + its
  active variants).
- `catalog.variant.get` → `VariantWithProductView` (variant of any status + its
  parent product header).

## The three read use cases

All under `application/use-cases/`, sharing
`application/use-cases/catalog-view.factory.ts` (pure functions `toProductView`,
`toProductVariantView`, `toProductWithVariantsView` — the last filters variants
to active). The factory is a **justified added file** not named in the task's
"Files to add" (DRY for the verbose variant projection across three read use
cases); it sits in the `use-cases/` folder (element type `application-use-case`),
imports only domain + contracts, and is not barreled (the use cases import it by
relative path).

- `ListProductsUseCase` — normalizes the page request (1-based `page`, default
  size **20**, capped at **100**), calls `repository.listActive({ page, size,
  search })`, maps to `IPage<ProductWithVariantsView>`. Browse filters on
  `status = active` (repository) and each product's active variants (factory).
- `GetProductBySlugUseCase` — `findBySlug` (status-agnostic — an archived product
  still resolves), unknown slug → `PRODUCT_NOT_FOUND`. Variant collection still
  filtered to active.
- `GetVariantUseCase` — `findVariantById` (status-agnostic — archived variant/
  product still resolves), unknown id → `VARIANT_NOT_FOUND`, then `findById` for
  the parent header (FK `ON DELETE RESTRICT` guarantees the parent; a miss is
  treated as a data-integrity error, not a not-found).

The list-filters-on-active **vs** resolvable-by-id/slug distinction is the
central read-path rule (ADR-025): **browse hides non-active**; **direct
resolve stays status-agnostic** so historical order/stock references (which key
on `variantId`) never dangle.

## Key decisions & deviations (task-08 must respect)

- **One new error code:** `CatalogErrorCodeEnum.VARIANT_NOT_FOUND` (=
  `'CATALOG_VARIANT_NOT_FOUND'`) added to `domain/catalog.exception.ts` for the
  `catalog.variant.get` miss — a distinct code from `PRODUCT_NOT_FOUND` so the
  gateway can map the variant lookup to its own 404. The exception file was not
  in the task's "Files to modify" list — a small justified deviation (the
  read not-found needs a typed code; reusing `PRODUCT_NOT_FOUND` would be
  semantically wrong).
- **`ICatalogRepositoryPort` is unchanged** — `findBySlug`, `findVariantById`,
  `listActive` already existed (task-04 stubs); no read-side query refinement was
  needed beyond them. The in-memory repository double's `listActive` was
  upgraded to honour `search` + pagination (slice + `total` of the full filtered
  set, newest-first) so the list spec is meaningful.
- **Reserved cache-key builder** (NOT consumed): `CATALOG_PRODUCT_KEY_VERSION =
  'v1'` + `CACHE_KEYS.catalogProductPrefix(variantId, opts?)` /
  `CACHE_KEYS.catalogProduct(variantId, opts?)` in `libs/cache/cache-keys.ts`,
  keyed on **`variantId`** (the downstream backbone, ADR-025), shape
  `ris:[t:<tenantId>:]catalog:product:v1:<variantId>:[__all__]`. Asserted in
  `libs/cache/spec/cache-keys.spec.ts` with a comment that it is reserved and not
  consumed. The catalog service does **not** import `CacheModule` — leave it that
  way until a future cached read path lands.

## Error-code → HTTP-status map task-08 owns

The gateway catalog module maps `CatalogErrorCodeEnum` → HTTP status. Suggested
(consistent with carryover-05/06):
- `PRODUCT_NOT_FOUND`, `VARIANT_NOT_FOUND` → **404**
- `PRODUCT_SLUG_TAKEN`, `VARIANT_SKU_TAKEN` → **409**
- `PRODUCT_INVALID_STATE_TRANSITION`, `PRODUCT_PUBLISH_REQUIRES_VARIANT`, and the
  domain invariant codes (`PRODUCT_NAME_REQUIRED`, `PRODUCT_SLUG_REQUIRED`,
  `VARIANT_SKU_REQUIRED`, `VARIANT_OPTION_VALUES_REQUIRED`,
  `VARIANT_WEIGHT_INVALID`, `VARIANT_DIMENSIONS_INVALID`) → **400**

## Known gaps (owned by later tasks)

- **API gateway catalog module** — the HTTP surface that exposes the seven RPCs
  and maps `CatalogErrorCodeEnum` → HTTP status, with RBAC (`@RequiresPermission`
  — the read routes are Customer-facing; pick the gate per route). **task-08.**
  When naming the paginated HTTP response, remember the `IPage`/`presentation`
  boundary above — the gateway presentation can reach `lib-contracts`
  (`IPage<ProductWithVariantsView>`) but not `lib-common`.
- **Kulala `http/catalog.http`** — **task-09.**
- **Seed + docs finalization** — **task-10** still owns: the catalog seed, the
  CLAUDE.md ADR "next free number" bump (still stale at "025" — ADR-025 is
  committed, should read "026") and a consolidated catalog domain section. (This
  task only updated the CLAUDE.md/README statements its own change made false —
  the architecture intro, message-pattern list, the catalog service section, the
  contracts sub-area, the cache-key-convention note, the README diagram box +
  services table.)
- **Pricing capability** — the deferred "≥1 active Price" publish precondition is
  still a warn-not-block seam in `publish-product.use-case.ts`. Not tasks 07–10.
- **`product_id` → `variantId` reshape** in inventory/retail + retail
  order-create validation against a published variant — later cross-context work,
  **not** tasks 07–10.

## Docs written vs pending

- `docs/implementation/02-catalog-product-and-variant/05-catalog-use-cases.md` —
  **extended**: H1 + intro now cover write **and** read; §6 error table gained the
  two read not-found rows; §8 ports lists the read helpers explicitly; **new §9
  "The read path"** (§9.1 the list-filters-on-active vs resolvable-by-id/slug
  distinction, §9.2 the three read use cases, §9.3 the pagination shape +
  the boundary-driven local `IPage` re-declaration, §9.4 the reserved cache-key
  builder); §10 verification gained the read-path coverage; "What this does not
  do" updated (read path uncached; gateway is the remaining future work).
- `docs/implementation/02-catalog-product-and-variant/06-catalog-events.md` —
  unchanged (complete from task-06).

## Files added

- `apps/catalog-microservice/src/modules/catalog/application/use-cases/list-products.use-case.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/get-product-by-slug.use-case.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/get-variant.use-case.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/catalog-view.factory.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/list-products.use-case.spec.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/get-product-by-slug.use-case.spec.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/get-variant.use-case.spec.ts`
- `libs/contracts/catalog/interfaces/list-products.interface.ts`
- `libs/contracts/catalog/interfaces/get-product-by-slug.interface.ts`
- `libs/contracts/catalog/interfaces/get-variant.interface.ts`
- `libs/contracts/catalog/dto/page.view.ts`
- `libs/contracts/catalog/dto/product-with-variants.view.ts`
- `libs/contracts/catalog/dto/variant-with-product.view.ts`

## Files modified

- `libs/messaging/routing-keys.constants.ts`,
  `libs/messaging/spec/routing-keys.constants.spec.ts`
- `libs/contracts/microservices/microservice-message-pattern.enum.ts`
- `libs/contracts/catalog/dto/index.ts`, `libs/contracts/catalog/interfaces/index.ts`
- `libs/cache/cache-keys.ts`, `libs/cache/spec/cache-keys.spec.ts`
- `apps/catalog-microservice/src/modules/catalog/domain/catalog.exception.ts`
  (+`VARIANT_NOT_FOUND`)
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/index.ts`
- `apps/catalog-microservice/src/modules/catalog/application/use-cases/spec/test-doubles.ts`
  (`listActive` search + pagination)
- `apps/catalog-microservice/src/modules/catalog/presentation/catalog.controller.ts`
- `apps/catalog-microservice/src/modules/catalog/catalog.module.ts`
- `docs/implementation/02-catalog-product-and-variant/05-catalog-use-cases.md`
- `CLAUDE.md`, `README.md`

## Files deleted

- None.

## How to verify

```bash
yarn lint                 # --max-warnings 0, exit 0
yarn test:unit            # 371 passed, 55 suites
yarn build                # 5 apps compile

# Regression (infra reload → migrate → seed → tests):
yarn test:e2e             # 5 suites / 55 tests / 38 snapshots (unchanged — no
                          #   catalog gateway endpoint yet; arrives in task-08)

# Boot the catalog service against running infra (DI graph + handler registration):
docker compose up -d rabbitmq mysql redis
OTEL_SDK_DISABLED=true node dist/apps/catalog-microservice/main.js
#   → "Catalog Microservice is listening for messages", no DI errors
docker exec rabbitmq rabbitmqctl list_queues name consumers   # catalog_queue → 1

# Self-containment gate (expected: no orchestration references):
grep -rniE 'tmp/|\bepic\b|\btask\b' \
  docs/ apps/ libs/ http/ scripts/ spec/ migrations/ README.md CLAUDE.md
```

Note: infra (rabbitmq/mysql/redis) was left **up and seeded** after the e2e run;
tear it down with `yarn test:infra:down` for a clean slate.
