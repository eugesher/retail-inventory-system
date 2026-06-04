# 05 — Catalog use cases

This document records the catalog **write** and **read** operations and the
application-layer rules they follow.

**Write** operations:

- **Register Product** — creates a `draft` product with no variants.
- **Add Variant** — appends a variant to an existing product, enforces global
  `sku` uniqueness, and emits a `catalog.variant.created` event.
- **Publish Product** — transitions a product `draft → active` (preconditions: ≥1
  variant, and an in-effect Price in the default currency for **every** variant)
  and emits a `catalog.product.published` event.
- **Archive Product** — transitions a product `active → archived` (terminal) and
  emits a `catalog.product.archived` event.

**Read** operations (the Customer-facing browse + resolve surface — §9):

- **List Products** — a paged browse of the published (active) catalogue; each
  product carries its active variants.
- **Get Product By Slug** — resolve a single product (any status) by its slug,
  with its active variants.
- **Get Variant** — resolve a single variant (any status) by id, with its parent
  product header.

It builds directly on the persistence seam from
[04 — `Product` and `ProductVariant` persistence](./04-product-and-variant-persistence.md)
and the domain from
[03 — The `Product` and `ProductVariant` domain](./03-product-and-variant-domain.md).
The aggregate rules it honors are
[ADR-025 (the catalog `Product` aggregate)](../../adr/025-catalog-product-and-variant-aggregate.md);
the event-publishing rules are
[ADR-020 (RabbitMQ as the inter-service bus)](../../adr/020-rabbitmq-as-inter-service-bus.md)
and [ADR-013 (the order aggregate / cross-service confirm)](../../adr/013-order-aggregate-and-cross-service-confirm.md),
whose publish-after-commit precedent this follows. The wire seam those events
ride is described in its sibling
[06 — Catalog events](./06-catalog-events.md). The code lives under
`apps/catalog-microservice/src/modules/catalog/application/use-cases/`.

## 1. Where a use case sits

A use case is the application-layer orchestrator between the RMQ controller and
the domain + ports. It:

1. receives the wire **command payload** (a plain interface from
   `@retail-inventory-system/contracts` carrying a `correlationId`),
2. drives the `Product` aggregate and the repository port,
3. returns a **view DTO** (the RPC response), and
4. for the event-bearing operations, publishes the resulting event through the
   events port.

The controller (`presentation/catalog.controller.ts`) is intentionally thin: it
maps a `@MessagePattern` to a use-case call and nothing else. `correlationId` is
logged **inline** inside the use case as a structured log field rather than via
`PinoLogger.assign()`, because `assign()` only works inside an HTTP request scope
and throws inside an RMQ handler
([ADR-001](../../adr/001-structured-logging-with-pino.md) /
[ADR-011](../../adr/011-notifier-port-and-adapters.md)).

## 2. Register Product

`RegisterProductUseCase.execute(payload)` takes `{ name, slug, description?,
correlationId }` and returns a `ProductView` (`{ id, name, slug, description,
status }`).

The flow is deliberately small:

1. **Build first.** `Product.create({ name, slug, description })` constructs a
   `draft` aggregate. The constructor enforces the domain invariants
   (`name`/`slug` non-empty), so an invalid command is rejected by the domain
   before any I/O.
2. **Uniqueness pre-check.** `repository.existsBySlug(slug)` — if the slug is
   already taken, raise a typed error (see §6) instead of letting the `INSERT`
   trip the UNIQUE constraint with a raw driver exception.
3. **Persist** via `repository.save(product)` and read back the assigned id.
4. **Return** the `ProductView` from the saved aggregate.

There is **no event** for product registration. The catalog model emits events
only for the three state-meaningful transitions — variant-created, published,
archived (ADR-025); `Product.create(...)` records none. A product is born in
`draft`, invisible to the published catalogue read path, until a later
**Publish** operation activates it.

## 3. Add Variant

`AddVariantUseCase.execute(payload)` takes `{ productId, sku, gtin?,
optionValues, weightG?, dimensionsMm?, correlationId }` and returns a
`ProductVariantView`.

1. **Load the parent.** `repository.findById(productId)` — a missing parent is
   rejected (see §6). A variant is only ever added **through its `Product` root**
   (ADR-025): it is a child entity, never persisted standalone.
2. **Uniqueness pre-check.** `repository.existsBySku(sku)` — reject a duplicate
   `sku` with a typed error.
3. **Mutate the aggregate.** `product.addVariant({ sku, gtin, optionValues,
   weightG, dimensionsMm })` appends the child and records an in-process
   `VariantCreatedEvent`. The variant's `id` is still `null` at this point —
   persistence has not run yet.
4. **Persist.** `repository.save(product)` writes the root + variants in one
   transaction and re-reads the graph, so the returned aggregate's variants
   carry concrete, DB-assigned ids.
5. **Emit after commit.** Drain `product.pullDomainEvents()`, re-read the
   concrete `variantId` from the **saved** aggregate (matched by the globally
   unique `sku`), build the versioned wire event, and publish it through the
   events port (see §7 and [06](./06-catalog-events.md)).
6. **Return** the `ProductVariantView` from the saved variant.

### Why re-read the id instead of trusting the in-process event

`VariantCreatedEvent` is recorded in step 3, **before** the row exists, so its
`variantId` is `null`. The wire event consumers need the concrete id, so the use
case re-reads it from the saved aggregate after step 4 and constructs the wire
event then (ADR-025 / ADR-013). The drained domain event still supplies the
`sku` (to match the right saved variant) and the `occurredAt` timestamp; only
the id comes from persistence. A `DomainEvent` subclass is **never serialized**
across services — the use case maps it to a plain wire interface first.

## 4. Publish Product

`PublishProductUseCase.execute(payload)` takes `{ productId, correlationId }` and
returns a `ProductView` whose `status` is `active` and whose `publishedAt` is the
transition timestamp.

1. **Load.** `repository.findById(productId)` — a missing product is rejected
   (see §6).
2. **Check the price precondition.** Collect the product's variant ids and ask
   the active-price probe which of them lack an in-effect Price in the default
   currency. If any do, the publish hard-fails with
   `PRODUCT_PUBLISH_REQUIRES_PRICE` (409) — nothing is persisted, no event is
   emitted (see the dedicated subsection below).
3. **Transition.** `product.publish()` — the domain enforces the two write-side
   preconditions it can see: the product is in `draft` and has **at least one
   variant**. A non-draft product raises `PRODUCT_INVALID_STATE_TRANSITION`; a
   variant-less product raises `PRODUCT_PUBLISH_REQUIRES_VARIANT`. On success the
   aggregate flips to `active` and records a `ProductPublishedEvent` carrying the
   slug and the concrete `variantIds`.
4. **Persist** via `repository.save(product)`.
5. **Emit after commit.** Drain `product.pullDomainEvents()`, map the
   `ProductPublishedEvent` to `ICatalogProductPublishedEvent`, and publish it
   through the events port (best-effort — see §7).
6. **Return** the `ProductView` with `status: 'active'` and `publishedAt`.

### The active-Price publish precondition — enforced via a probe

`PublishProductUseCase` enforces two preconditions. The variant count is
delegated to `Product.publish()` (the domain rejects a `draft` product with zero
variants). The second — "**every** variant has an in-effect Price in the default
currency" — is a real business rule, but it is a **cross-aggregate fact** the
catalog `Product` cannot see, so it never belongs in the `Product` model. It is
enforced **in this use case**, not the domain, via a catalog-side
`IActivePriceProbePort`: the probe reads the pricing-owned `price` table with a
parameterized query and reports which variant ids are unpriced. A non-empty
result hard-fails the publish with `PRODUCT_PUBLISH_REQUIRES_PRICE` → **409
Conflict**.

The catalog module imports **nothing** from the pricing module — the probe's
`price`-table read is the symmetric mirror of how pricing writes the
catalog-owned `product_variant.tax_category_id`, with the opaque `variantId` and
the table as the only coupling. The two precondition layers stay independent: a
variant-less product hands the probe an empty id list (a no-op), so it still
fails on the domain's `PRODUCT_PUBLISH_REQUIRES_VARIANT`, not the price rule. The
full rationale — why 409, the probe port, the `DEFAULT_CURRENCY` knob — is in
[03-pricing · 04 — Publishing hard-fails on a missing active Price](../03-pricing-price-and-tax-category/04-publish-precondition-hard-fail.md).

## 5. Archive Product

`ArchiveProductUseCase.execute(payload)` takes `{ productId, correlationId }` and
returns a `ProductView` whose `status` is `archived` and whose `archivedAt` is the
transition timestamp.

1. **Load.** `repository.findById(productId)` — a missing product is rejected
   (see §6).
2. **Transition.** `product.archive()` — the domain enforces that only an
   `active` product can be archived; any other state raises
   `PRODUCT_INVALID_STATE_TRANSITION`. On success the aggregate flips to
   `archived` and records a `ProductArchivedEvent`.
3. **Persist** via `repository.save(product)`.
4. **Emit after commit.** Drain `product.pullDomainEvents()`, map the
   `ProductArchivedEvent` to `ICatalogProductArchivedEvent`, and publish it
   through the events port (best-effort — see §7).
5. **Return** the `ProductView` with `status: 'archived'` and `archivedAt`.

### Archival semantics — hidden from browse, still resolvable

Archival is the catalog's **soft-delete**, expressed purely through `status`
(ADR-025): the row is never physically deleted and the inherited
`BaseEntity.deletedAt` column stays inert. The transition is **terminal** — there
is no `archived → draft` or `archived → active` path.

An archived product is **hidden from browse** — the published-catalogue read path
lists only `status = active` products, so an archived product drops out of the
catalogue. But it stays **resolvable by id and slug**: a direct lookup still
returns it (an order that already references one of its variants, an admin view,
or a consumer reacting to the archived event can all still read it). That is why
the operation emits `catalog.product.archived` rather than silently mutating a
row — a downstream consumer that maintains its own projection (e.g. a search index
that should delist the product) needs the signal.

## 6. Rejections — one typed error channel

Every use case rejects through `CatalogDomainException`, the single typed-error
class for the catalog context, carrying a `CatalogErrorCodeEnum` code. The
presentation/gateway layer maps the code to an HTTP status (the gateway module is
later work); nothing string-matches an exception message (ADR-025).

| Condition | Code | Raised by |
|---|---|---|
| Duplicate `slug` | `PRODUCT_SLUG_TAKEN` | Register Product |
| Parent product missing | `PRODUCT_NOT_FOUND` | Add Variant |
| Duplicate `sku` | `VARIANT_SKU_TAKEN` | Add Variant |
| Product missing | `PRODUCT_NOT_FOUND` | Publish / Archive Product |
| Publishing a non-draft product | `PRODUCT_INVALID_STATE_TRANSITION` | Publish Product |
| Publishing a variant-less product | `PRODUCT_PUBLISH_REQUIRES_VARIANT` | Publish Product |
| Archiving a non-active product | `PRODUCT_INVALID_STATE_TRANSITION` | Archive Product |
| Unknown slug | `PRODUCT_NOT_FOUND` | Get Product By Slug |
| Unknown variant id | `VARIANT_NOT_FOUND` | Get Variant |

The state-transition and variant-count codes are raised **by the domain** inside
`Product.publish()` / `Product.archive()`; the `*_TAKEN` and `PRODUCT_NOT_FOUND`
codes are **repository-level** facts the aggregate cannot see (it has no
cross-aggregate view), so the use case pre-checks them through `existsBySlug` /
`existsBySku` / `findById` and raises the typed code. The uniqueness pre-check is
for a clean error message only — correctness rests on the schema's UNIQUE
constraints, which still reject a duplicate that races past the pre-check and fail
the transaction.

## 7. Publish-after-commit, best-effort

The three event-bearing operations publish their event **after** the write is
committed, and the publish is **best-effort**: a broker/publish failure is
`warn`-logged and swallowed, never raised. The state change is already durably
persisted; event fan-out is a downstream convenience, not part of the write's
success contract. This mirrors the retail `order.created` publish
([ADR-013](../../adr/013-order-aggregate-and-cross-service-confirm.md) /
[ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)): there is no
transactional outbox today, so the system accepts at-most-once delivery on the
commit-to-publish hop in exchange for not coupling the write's success to the
broker's availability.

The events port (`ICatalogEventsPublisherPort` / `CATALOG_EVENTS_PUBLISHER`) is
the seam that keeps the use cases free of any RabbitMQ type — they depend on the
port; only the adapter holds a `ClientProxy`. The port shape, the adapter, and
the wire contracts are described in [06 — Catalog events](./06-catalog-events.md).

## 8. Ports the use cases depend on

- `ICatalogRepositoryPort` (`CATALOG_REPOSITORY`) — the write helpers `save`,
  `findById`, `existsBySlug`, `existsBySku`, and the read helpers `findBySlug`,
  `findVariantById`, and `listActive(query)` used by the read path (§9). Returns
  domain types only; no TypeORM type leaks into the application layer (ADR-017).
  Detailed in [04](./04-product-and-variant-persistence.md).
- `ICatalogEventsPublisherPort` (`CATALOG_EVENTS_PUBLISHER`) —
  `publishVariantCreated`, `publishProductPublished`, `publishProductArchived`
  (each `(event, correlationId?)`). The use case builds the wire event; the
  adapter emits it. Detailed in [06](./06-catalog-events.md).

### Note on `ProductView` and the transition timestamps

`ProductView` is reused as the response of all three product operations. It gained
two optional fields, `publishedAt` and `archivedAt`, populated **only** by the
operation that performs the matching transition (publish sets `publishedAt`,
archive sets `archivedAt`); a plain register response carries neither. The
timestamp value is the drained domain event's `occurredAt` rendered as an ISO-8601
string — the same instant the wire event carries (see
[06](./06-catalog-events.md) §2).

## 9. The read path

The read path is the Customer-facing surface: browse the published catalogue and
resolve a single product or variant. It is served by three query use cases over
the same `ICatalogRepositoryPort` the write path uses (read-only helpers — no new
port), and the controller adds three `@MessagePattern` handlers
(`catalog.product.list`, `catalog.product.get`, `catalog.variant.get`). There is
**no cache** on this path yet — the catalog service does not import `CacheModule`
(but a reserved cache-key builder is in place — §9.4).

Each read query is a plain interface from `@retail-inventory-system/contracts`
carrying a `correlationId`, exactly like the write commands. The responses reuse
the write-path `ProductView` / `ProductVariantView` as their building blocks.

### 9.1 The list-filters-on-active vs resolvable-by-id distinction

This is the central rule of the read path, and it is deliberately split two ways
(ADR-025):

- **Browse hides non-active.** `ListProductsUseCase` calls
  `repository.listActive(...)`, which filters on `status = active`. A `draft`
  product (not yet published) and an `archived` product (soft-deleted) both drop
  out of the catalogue listing. Within each listed product, the read view carries
  its **active variants only** — an archived variant is filtered out of the
  collection.
- **Resolve stays status-agnostic.** `GetProductBySlugUseCase` (`findBySlug`) and
  `GetVariantUseCase` (`findVariantById`) return the entity **regardless of
  status**. An archived product is still resolvable by its slug, and an archived
  variant is still resolvable by its id. This is required for correctness:
  inventory stock, pricing, and order lines key on `variantId` (the downstream
  backbone — ADR-025), so a historical order that references a now-archived
  variant must never see that reference dangle. Archival is a *catalogue
  visibility* decision, not a *deletion*.

So the two concerns are kept distinct on purpose: the **list** filter narrows to
active; the **by-slug / by-id** fetch resolves anything. `GetProductBySlugUseCase`
still filters its *variant collection* to active (the by-slug response is a
browse-shaped product detail), but `GetVariantUseCase` applies no status filter at
all — it is the explicit "resolve this exact variant" path.

### 9.2 The three read use cases

- **`ListProductsUseCase`** — takes `IListProductsQuery` (`{ status?, page?,
  pageSize?, search?, correlationId }`) and returns `IPage<ProductWithVariantsView>`.
  It normalizes the page request (1-based `page`, default page size 20, capped at
  100 so an oversized `pageSize` cannot ask for an unbounded result set), then
  calls `repository.listActive({ page, size, search })`. The `status` field
  defaults to `active` on the contract and is reserved for a future non-active
  browse — today the path serves the active catalogue only. The optional `search`
  is a name/slug substring filter, passed straight through to the repository.
- **`GetProductBySlugUseCase`** — takes `IGetProductBySlugQuery` (`{ slug,
  correlationId }`) and returns `ProductWithVariantsView`. `findBySlug` resolves
  the product regardless of status; an unknown slug rejects with
  `PRODUCT_NOT_FOUND` (§6).
- **`GetVariantUseCase`** — takes `IGetVariantQuery` (`{ variantId,
  correlationId }`) and returns `ProductVariantView & { product: ProductView }`
  (the `VariantWithProductView`). `findVariantById` resolves the variant
  regardless of status; an unknown id rejects with `VARIANT_NOT_FOUND` (§6). It
  then loads the parent product header via `findById(variant.productId)` — the
  variant carries a non-null FK to its product (`ON DELETE RESTRICT`), so a
  missing parent is treated as a data-integrity breach, not a not-found.

### 9.3 The pagination shape

The list response is an `IPage<ProductWithVariantsView>` — `{ items, total, page,
size }`, where `total` is the count of *all* matching (active) products and
`items` is the page slice. The canonical pagination types `IPage<T>` /
`IPageRequest` live in `@retail-inventory-system/common`
([ADR-005](../../adr/005-split-shared-common-into-bounded-libs.md)); they are
**not** imported into the wire contract. The architecture boundaries
([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)) keep
`libs/contracts` importing only `libs/contracts`, and the gateway-facing
`presentation` layer that names the response type can reach `libs/contracts` but
not `libs/common`. So the wire contract re-declares the identical
`{ items, total, page, size }` shape locally in `libs/contracts/catalog/dto/` —
the same local-declaration pattern the catalog repository port uses for its
internal `IProductPage` (the application layer maps one onto the other).

### 9.4 The reserved catalog cache-key builder

The read path is **not cached** today, but a versioned cache-key builder is
reserved so a future cached read path can adopt it without re-keying. In
`libs/cache/cache-keys.ts`:

- `CATALOG_PRODUCT_KEY_VERSION = 'v1'` — the per-aggregate schema-version
  constant, alongside the inventory/retail ones.
- `CACHE_KEYS.catalogProductPrefix(variantId, opts?)` →
  `ris:[t:<tenantId>:]catalog:product:v1:<variantId>:`
- `CACHE_KEYS.catalogProduct(variantId, opts?)` →
  `…:<variantId>:__all__`

The key is on **`variantId`, not `productId`**: the variant is the unit with a
stock/price/order-line, so a future cached catalog read keys on the variant
(ADR-025), matching the rest of the downstream backbone. The shape follows the
`ris:[t:<tenantId>:]<service>:<aggregate>:<version>:<id>[:<facet>]` convention
([ADR-016](../../adr/016-cache-aside-generalized.md) +
[ADR-022](../../adr/022-cache-keys-tenant-and-schema-version.md)): the non-glob
`__all__` facet sentinel, the opt-in (never-defaulted) tenant segment, and the
one-line-bump version constant that makes a breaking DTO shape change re-key every
entry on the next deploy. The builder is locked by an assertion in
`libs/cache/spec/cache-keys.spec.ts` but is **not consumed by any code path** —
the catalog service still does not import `CacheModule`.

## 10. Verification

- `yarn lint` (`--max-warnings 0`) is clean: the use cases import only the
  domain, the ports, and contracts — no `@nestjs/microservices`, no `typeorm`.
- `yarn test:unit` covers, per operation:
  - **Register** — happy path + duplicate-slug rejection.
  - **Add Variant** — happy path (the emitted `catalog.variant.created` carries
    the **persisted** `variantId`), parent-not-found and duplicate-sku
    rejections, and the best-effort publish (the variant is still returned when
    the publisher rejects).
  - **Publish** — happy path (`draft` + ≥1 variant → `active`, emits
    `catalog.product.published` with the right `variantIds`), the no-variants
    rejection, the not-found rejection, and the best-effort publish.
  - **Archive** — happy path (`active → archived`, emits
    `catalog.product.archived`), the non-active rejection, the not-found
    rejection, and the best-effort publish.
  - **List Products** — returns only `active` products with their `active`
    variants; the pagination shape (`total` vs page slice); default page/size;
    the `search` filter passed through.
  - **Get Product By Slug** — happy path; an archived product still resolves by
    slug; unknown slug → `PRODUCT_NOT_FOUND`.
  - **Get Variant** — happy path (variant + parent header); an archived variant
    on an archived product still resolves; unknown id → `VARIANT_NOT_FOUND`.

  The repository and publisher are in-memory test doubles; the repository double
  mimics the real adapter's post-commit id assignment and its `listActive`
  search/pagination.

## What this does not do

The "≥1 active Price" publish precondition is **not** part of this use case (§4):
`PublishProductUseCase` enforces only the ≥1-variant rule, and the active-Price
check is owned by the pricing capability and enforced where pricing joins the
publish path. The read path is **not cached** (§9.4 reserves the key builder but
the service does not import `CacheModule`). The API gateway catalog module — the HTTP surface that
exposes these RPCs and maps `CatalogErrorCodeEnum` → HTTP status — is later work,
described in its own document as it lands.
