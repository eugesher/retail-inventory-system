# ADR-025: Catalog `Product` aggregate and its `ProductVariant` children

- **Date**: 2026-06-02
- **Status**: Accepted

---

## Context

The system needs an owner for the merchandisable graph — the products a shop
lists and the concrete, sellable units a customer actually buys. Until now no
service owned this. The inventory microservice carried a vestigial `product`
table whose only job was to be a foreign-key target for
`product_stock.product_id`; it held no behaviour and no use case read or wrote
it through a domain model. That stub was removed outright (see
[02 — Removing the inventory `product` stub](../implementation/02-catalog-product-and-variant/02-inventory-product-stub-removed.md)),
which freed the `product` table name in the shared `retail_db` schema for a
context that actually owns product identity.

A new `catalog` bounded context now exists as its own deployable
(`apps/catalog-microservice/`, [ADR-004](004-adopt-hexagonal-architecture-per-service.md)
per-module hexagonal, [ADR-018](018-nestjs-monorepo-apps-and-libs.md) monorepo).
This decision records the shape of its write-side domain: the aggregate
boundary, the lifecycle state machines, the cross-aggregate invariants, and the
in-process domain events. It covers the domain layer only — persistence,
use cases, and cross-service wiring are realized by the catalog persistence and
application work that builds on this model.

The closest precedent is the retail `Order` aggregate
([ADR-013](013-order-aggregate-and-cross-service-confirm.md)): an
`AggregateRoot` that owns child entities, records in-process `DomainEvent`s, and
drains them via `pullDomainEvents()`. Catalog follows that template and diverges
only where the merchandising domain genuinely differs.

## Decision

### 1. `Product` is the aggregate root; `ProductVariant` is a child entity

`Product extends AggregateRoot<number | null>` and owns a `ProductVariant[]`.
A variant is **a child entity inside `Product` on the write path** — it is
added and validated through the root (`Product.addVariant(...)`), never
constructed and persisted as a free-standing aggregate. The `number | null` id
mirrors `Order`: `null` before persistence assigns an id, concrete after
`Product.reconstitute(...)`.

On the **read path** a variant is addressable top-level (a shopper looks up a
variant by id or SKU). That is served by a separate read model in the query
work — it is **not** a second write aggregate. Keeping a single write root means
all invariants that span the product and its variants (e.g. "publish needs
≥1 variant") have exactly one owner.

`ProductVariant` is the **sellable, stocked, priced unit and the downstream
backbone key.** Inventory stock, pricing, and order lines key on the
`variantId`, not the product id — a product is a merchandising grouping, the
variant is the thing with a price, a stock level, and a place on an order line.

### 2. Two lifecycle state machines, both soft-deleting via `status`

`ProductStatusEnum` is `draft | active | archived`:

- `draft → active` via `Product.publish()`. Precondition enforced in the
  domain: **at least one variant**.
- `active → archived` via `Product.archive()`.
- **No** `archived → draft` and **no** `archived → active` — archival is
  terminal. `publish()` on a non-draft and `archive()` on a non-active raise a
  `CatalogDomainException`.

`ProductVariantStatusEnum` is `active | archived`. Variants are born `active`;
variant-level archival is not a write operation today (the enum is modelled for
persistence and future flows, but the only transition exercised is
construction).

**Soft-delete is via `status`, never a `deletedAt` timestamp.** An archived
product or variant stays resolvable forever, because historical orders and
stock rows reference variants by id — an id that resolved to a row yesterday
must still resolve tomorrow. The `deletedAt` column inherited from
`BaseEntity` ([ADR-005](005-split-shared-common-into-bounded-libs.md) /
[ADR-019](019-typeorm-and-mysql-for-persistence.md)) is left **inert** on the
catalog tables; the lifecycle is `status`-driven.

### 3. No optimistic-lock `version` column

Catalog is **last-writer-wins.** It is not in the no-oversell critical path —
that path is the inventory `StockItem` reservation flow
([ADR-012](012-stock-aggregate-and-port-adapter.md)). A concurrent edit to a
product's name or description losing to another edit is an acceptable
merchandising-side trade-off, so no `version` column / optimistic lock is added
at this stage. If a concrete concurrency hazard emerges (e.g. a variant matrix
edited by two managers at once), it becomes its own decision then.

### 4. Invariants and where each is enforced

Enforced **in the domain** (a `CatalogDomainException` with a typed code from
`CatalogErrorCodeEnum`):

- `Product.name` non-empty, `Product.slug` non-empty.
- `ProductVariant.sku` non-empty.
- `ProductVariant.optionValues` is a non-empty map of non-empty string→string
  pairs (modelled as the `OptionValues` value object).
- `ProductVariant.weightG`, when present, is a non-negative integer.
- `ProductVariant.dimensionsMm`, when present, has non-negative integer
  millimetre axes (the `Dimensions` value object — symmetric with `weightG`).
- `Product.publish()` requires `variants.length >= 1`.

Enforced **at the repository** (the domain cannot see other aggregates, so it
trusts the repository to reject a clash):

- `Product.slug` global uniqueness.
- `ProductVariant.sku` global uniqueness.

These two are unique constraints in the persistence schema and are asserted in
the register/add-variant use-case specs against a repository test double — not
in the domain specs.

### 5. Three in-process domain events, mapped to versioned wire events later

The aggregate records three `DomainEvent<number>` subclasses (the
`aggregateId` is the product id):

- `VariantCreatedEvent` — carries `variantId` (`number | null` — see below) and
  `sku`. Recorded by `Product.addVariant(...)`.
- `ProductPublishedEvent` — carries `slug` and `variantIds: number[]`. Recorded
  by `Product.publish()`.
- `ProductArchivedEvent` — carries just the product id. Recorded by
  `Product.archive()`.

These are **in-process** events. As with `Order`
([ADR-013](013-order-aggregate-and-cross-service-confirm.md) §5) and the
notification template ([ADR-011](011-notifier-port-and-adapters.md)), a
`DomainEvent` subclass is **never serialized across services.** The application
use case drains them via `pullDomainEvents()` after the repository round-trip
and maps each to a **versioned (`v1`) wire event** — the version travels in the
routing key / payload, following the dotted-routing-key convention
([ADR-008](008-rabbitmq-via-libs-messaging.md)) and the schema-versioning
spirit of [ADR-022](022-cache-keys-tenant-and-schema-version.md). Versioning
the wire contract from the first publish means a later breaking payload change
is a `v2` key rather than a silent reshape. The concrete wire DTOs, routing
keys, and the use-case mapping land with the catalog application work.

`VariantCreatedEvent.variantId` is `number | null` because a freshly added
variant has no id until persistence assigns one — `addVariant` can run before
the first save. The use case re-reads the concrete id from the saved aggregate
before emitting the wire event, so a `null` never reaches a subscriber.

### 6. The publish "active Price" precondition is a documented seam, not code

A published product should arguably also require **≥1 active Price**. Pricing
is a separate future capability; there is no Price aggregate to read yet.
Rather than fabricate a half-modelled price check, `Product.publish()` enforces
only the variant-count precondition, and the requirement is recorded as a
clearly-named placeholder in the method's documentation. Until pricing lands,
the publish **use case** (application layer) will *warn* rather than *block* on
a price-less product — the warn lives in the use case, not the domain, so the
domain stays free of a dependency it cannot yet express.

### 7. Lifecycle enums live in `domain/`, not `libs/contracts`

`Order` put `OrderStatusEnum` in `libs/contracts` because the wire DTOs
reference it. Catalog's `ProductStatusEnum` / `ProductVariantStatusEnum` are
**internal domain concepts** at this stage — no cross-service contract names
them. They live in the catalog `domain/` and the boundaries lint
([ADR-017](017-architecture-lint-via-eslint-boundaries.md)) confirms the domain
imports only `libs/{ddd,common,contracts}`. If a wire contract later needs a
status, the versioned wire DTO can carry its own representation without coupling
the domain enum to the transport.

### 8. First concrete consumer of `DomainException`

The catalog domain is the first place to actually subclass the framework-free
`DomainException` from `libs/common`. Earlier aggregates (`Order`, `StockItem`)
threw plain `Error`. A single `CatalogDomainException` carries a typed `code`
from `CatalogErrorCodeEnum`, so the application/presentation layer can map a
code to an HTTP status without string-matching messages, while the domain stays
transport-free. This is a deliberate, contained step toward typed domain errors;
it does not retro-fit the older aggregates.

## Alternatives considered

1. **Keep `product` inside the inventory service.** Rejected. Inventory owns
   *stock*, not *merchandising*. The stub held no behaviour, and leaving it
   would have blocked the catalog context from owning the `product` table under
   the shared schema. Removal up front was the cleaner break.
2. **Key the downstream backbone on `productId` rather than `variantId`.**
   Rejected. The variant — not the product — is the unit with a price, a stock
   level, and a place on an order line. Keying on the product would force every
   downstream context to re-resolve "which variant" and would not survive a
   multi-variant product.
3. **Add an optimistic-lock `version` column now.** Rejected. Catalog is
   last-writer-wins and not in the no-oversell path; a `version` column would be
   speculative machinery. It can be added under its own decision if a concrete
   concurrency hazard appears.
4. **Make `ProductVariant` its own aggregate root.** Rejected. The
   product↔variant invariants (publish needs ≥1 variant; variants belong to
   exactly one product) need a single transactional owner. A top-level variant
   *read* model serves lookups without a second write root.
5. **Model `optionValues` / `dimensionsMm` as bare records on the entity.**
   Considered. Promoted both to value objects so the non-empty-map and
   non-negative-mm invariants have one home; `sku`/`slug` stay
   primitive-plus-invariant on the model because their only rule is "non-empty".

## Consequences

- The catalog domain layer exists and is framework-free
  (`apps/catalog-microservice/src/modules/catalog/domain/`), with spec siblings
  covering the transitions, rejections, invariants, and recorded events.
- **`variantId` is the forward backbone.** Later inventory work reshapes
  `product_stock.product_id` onto a catalog `variantId`, and the retail
  order-create flow gains validation against a published variant. Both are owned
  by the work that wires those contexts to the catalog read path — not by the
  catalog build itself.
- The `BaseEntity.deletedAt` column is inherited by the catalog tables but left
  inert; anyone reading the schema should treat `status` as the lifecycle
  source of truth.
- Catalog is the first concrete `DomainException` consumer; the typed-error
  pattern is available for other contexts to adopt without an additional
  decision.
- The wire-event versioning convention (`v1` from the first publish) is fixed
  here even though the concrete wire DTOs land with the application work, so the
  later publisher has no room to ship an unversioned key.

## References

- [ADR-004](004-adopt-hexagonal-architecture-per-service.md) — the per-module
  hexagonal layout the catalog domain sits inside (`domain/` imports only
  `libs/{ddd,common,contracts}`).
- [ADR-013](013-order-aggregate-and-cross-service-confirm.md) — the `Order`
  aggregate this model mirrors (`AggregateRoot` + `pullDomainEvents()`; the
  create-path id-assignment trade-off in its §5).
- [ADR-011](011-notifier-port-and-adapters.md) — the rule that a `DomainEvent`
  subclass is never serialized across services; wire events are plain
  contracts.
- [ADR-012](012-stock-aggregate-and-port-adapter.md) — the inventory `StockItem`
  flow that *is* the no-oversell critical path, contrasting with catalog's
  last-writer-wins stance.
- [ADR-008](008-rabbitmq-via-libs-messaging.md) /
  [ADR-022](022-cache-keys-tenant-and-schema-version.md) — the dotted-routing-key
  and schema-versioning conventions the `v1` wire events follow.
- [02 — Removing the inventory `product` stub](../implementation/02-catalog-product-and-variant/02-inventory-product-stub-removed.md)
  — the cleanup that freed the `product` table name for this context.
- [03 — The `Product` and `ProductVariant` domain](../implementation/02-catalog-product-and-variant/03-product-and-variant-domain.md)
  — the implementation companion to this decision.
