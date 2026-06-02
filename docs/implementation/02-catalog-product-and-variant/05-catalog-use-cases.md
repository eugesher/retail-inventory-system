# 05 — Catalog write use cases

This document records the first two catalog **write** operations and the
application-layer rules they follow:

- **Register Product** — creates a `draft` product with no variants.
- **Add Variant** — appends a variant to an existing product, enforces global
  `sku` uniqueness, and emits a `catalog.variant.created` event.

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
4. for Add Variant, publishes the resulting event through the events port.

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
   already taken, raise a typed error (see §4) instead of letting the `INSERT`
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
   rejected (see §4). A variant is only ever added **through its `Product` root**
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
   events port (see §5 and [06](./06-catalog-events.md)).
6. **Return** the `ProductVariantView` from the saved variant.

### Why re-read the id instead of trusting the in-process event

`VariantCreatedEvent` is recorded in step 3, **before** the row exists, so its
`variantId` is `null`. The wire event consumers need the concrete id, so the use
case re-reads it from the saved aggregate after step 4 and constructs the wire
event then (ADR-025 / ADR-013). The drained domain event still supplies the
`sku` (to match the right saved variant) and the `occurredAt` timestamp; only
the id comes from persistence. A `DomainEvent` subclass is **never serialized**
across services — the use case maps it to a plain wire interface first.

## 4. Rejections — one typed error channel

Both use cases reject through `CatalogDomainException`, the single typed-error
class for the catalog context, carrying a `CatalogErrorCodeEnum` code. The
presentation/gateway layer maps the code to an HTTP status (the gateway module is
later work); nothing string-matches an exception message (ADR-025).

| Condition | Code | Raised by |
|---|---|---|
| Duplicate `slug` | `PRODUCT_SLUG_TAKEN` | Register Product |
| Parent product missing | `PRODUCT_NOT_FOUND` | Add Variant |
| Duplicate `sku` | `VARIANT_SKU_TAKEN` | Add Variant |

These three join the domain-invariant codes (`PRODUCT_NAME_REQUIRED`,
`VARIANT_SKU_REQUIRED`, …) the aggregate already raises. They are **repository-
level** facts the aggregate cannot see (it has no cross-aggregate view), so the
use case pre-checks them through `existsBySlug` / `existsBySku` / `findById` and
raises the typed code. The pre-check is for a clean error message only —
correctness rests on the schema's UNIQUE constraints, which still reject a
duplicate that races past the pre-check and fail the transaction.

## 5. Publish-after-commit, best-effort

Add Variant publishes `catalog.variant.created` **after** the variant is
committed, and the publish is **best-effort**: a broker/publish failure is
`warn`-logged and swallowed, never raised. The variant is already durably
persisted; event fan-out is a downstream convenience, not part of the write's
success contract. This mirrors the retail `order.created` publish
([ADR-013](../../adr/013-order-aggregate-and-cross-service-confirm.md) /
[ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)): there is no
transactional outbox today, so the system accepts at-most-once delivery on the
commit-to-publish hop in exchange for not coupling the write's success to the
broker's availability.

The events port (`ICatalogEventsPublisherPort` / `CATALOG_EVENTS_PUBLISHER`) is
the seam that keeps the use case free of any RabbitMQ type — it depends on the
port; only the adapter holds a `ClientProxy`. The port shape, the adapter, and
the wire contract are described in [06 — Catalog events](./06-catalog-events.md).

## 6. Ports the use cases depend on

- `ICatalogRepositoryPort` (`CATALOG_REPOSITORY`) — `save`, `findById`,
  `existsBySlug`, `existsBySku`, plus the read helpers used by later work.
  Returns domain types only; no TypeORM type leaks into the application layer
  (ADR-017). Detailed in [04](./04-product-and-variant-persistence.md).
- `ICatalogEventsPublisherPort` (`CATALOG_EVENTS_PUBLISHER`) — `publishVariant
  Created(event, correlationId?)`. The use case builds the wire event; the
  adapter emits it. Detailed in [06](./06-catalog-events.md).

## 7. Verification

- `yarn lint` (`--max-warnings 0`) is clean: the use cases import only the
  domain, the ports, and contracts — no `@nestjs/microservices`, no `typeorm`.
- `yarn test:unit` covers, for Register Product, the happy path and the
  duplicate-slug rejection; for Add Variant, the happy path (including the
  emitted `catalog.variant.created` carrying the **persisted** `variantId`), the
  parent-not-found and duplicate-sku rejections, and the best-effort publish
  (the variant is still returned when the publisher rejects). The repository and
  publisher are in-memory test doubles; the repository double mimics the real
  adapter's post-commit id assignment.

## What this does not do

Publish and Archive are separate operations (the "≥1 active Price" warn-not-block
seam lives in the Publish use case); the read path (top-level variant addressing
as a read model) and the API gateway catalog module (HTTP surface + the
`CatalogErrorCodeEnum` → HTTP-status mapping) are later work. This document gains
a Publish/Archive section and a read-path note as those land.
