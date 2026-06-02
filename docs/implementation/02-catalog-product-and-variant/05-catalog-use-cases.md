# 05 — Catalog write use cases

This document records the catalog **write** operations and the application-layer
rules they follow:

- **Register Product** — creates a `draft` product with no variants.
- **Add Variant** — appends a variant to an existing product, enforces global
  `sku` uniqueness, and emits a `catalog.variant.created` event.
- **Publish Product** — transitions a product `draft → active` (precondition: ≥1
  variant) and emits a `catalog.product.published` event.
- **Archive Product** — transitions a product `active → archived` (terminal) and
  emits a `catalog.product.archived` event.

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
2. **Pricing precondition seam (warn, don't block).** See below.
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

### The deferred active-price precondition

A second precondition — "the product has **≥1 active Price**" — is *not* enforced
yet. Price is owned by a **future pricing capability** that does not exist in the
system today (there is no `Price` entity, table, or column). Until that capability
lands, `PublishProductUseCase` does **not** block a price-less product: where the
real check will live, it logs a `warn`
(`active price precondition not yet enforced — pricing capability pending`) and
proceeds.

This is a deliberate, named **seam**. The warn sits at the point in the flow where
the future hard check belongs (right before the `publish()` transition), so the
pricing capability replaces the warn with a real assertion — and, if it fails it,
a typed rejection — **without reshaping the use case**. The domain is left out of
this entirely: `Product.publish()` guards only the variant count (ADR-025);
"≥1 active Price" is a cross-aggregate fact the `Product` cannot see, so it lives
in the use case, never in the model.

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

- `ICatalogRepositoryPort` (`CATALOG_REPOSITORY`) — `save`, `findById`,
  `existsBySlug`, `existsBySku`, plus the read helpers used by the read path.
  Returns domain types only; no TypeORM type leaks into the application layer
  (ADR-017). Detailed in [04](./04-product-and-variant-persistence.md).
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

## 9. Verification

- `yarn lint` (`--max-warnings 0`) is clean: the use cases import only the
  domain, the ports, and contracts — no `@nestjs/microservices`, no `typeorm`.
- `yarn test:unit` covers, per operation:
  - **Register** — happy path + duplicate-slug rejection.
  - **Add Variant** — happy path (the emitted `catalog.variant.created` carries
    the **persisted** `variantId`), parent-not-found and duplicate-sku
    rejections, and the best-effort publish (the variant is still returned when
    the publisher rejects).
  - **Publish** — happy path (`draft` + ≥1 variant → `active`, emits
    `catalog.product.published` with the right `variantIds`), the deferred-price
    warn-and-proceed, the no-variants rejection, the not-found rejection, and the
    best-effort publish.
  - **Archive** — happy path (`active → archived`, emits
    `catalog.product.archived`), the non-active rejection, the not-found
    rejection, and the best-effort publish.

  The repository and publisher are in-memory test doubles; the repository double
  mimics the real adapter's post-commit id assignment.

## What this does not do

The "≥1 active Price" publish precondition is a deferred warn-not-block seam (§4) —
the pricing capability that turns it into a hard check is future work. The read
path (the published-catalogue query surface and top-level variant addressing) and
the API gateway catalog module (the HTTP surface + the `CatalogErrorCodeEnum` →
HTTP-status mapping) are later work, described in their own documents as they
land.
