# 03 — The `Product` and `ProductVariant` domain

This document records the **write-side domain** of the catalog bounded context:
a `Product` aggregate root that owns its `ProductVariant` children, two
lifecycle state machines, the cross-aggregate invariants, and three in-process
domain events. It is pure, framework-free domain code — no persistence, no
NestJS wiring, no transport. Those layers build on this model in the catalog
persistence and application work.

The code lives under
`apps/catalog-microservice/src/modules/catalog/domain/`. The catalog service was
scaffolded empty (see
[01 — The catalog microservice scaffold](./01-new-catalog-microservice-scaffold.md));
the `product` table name was freed by
[02 — Removing the inventory `product` stub](./02-inventory-product-stub-removed.md).
The decision and its rationale are in
[ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md); the closest
precedent — the retail `Order` aggregate — is
[ADR-013](../../adr/013-order-aggregate-and-cross-service-confirm.md). This file
is the implementation companion: what is on disk and how it behaves.

## 1. Aggregate boundaries: one write root, a top-level read view

`Product` is the **aggregate root**. It extends `AggregateRoot<number | null>`
from `@retail-inventory-system/ddd` and owns a `ProductVariant[]`. The
`number | null` id encodes the pre/post-persistence split: `Product.create(...)`
builds a root with `id: null`, and `Product.reconstitute(...)` rebuilds one with
the id storage assigned.

A `ProductVariant` is a **child entity** (extends `Entity<number | null>`), not
an aggregate of its own. On the **write path** a variant is only ever created
and validated *through the root* — `Product.addVariant(...)`. There is no public
way to persist or mutate a variant on its own. This keeps every invariant that
spans the product and its variants (most importantly "publish needs ≥1 variant")
under a single owner.

On the **read path** a variant is addressable top-level — a shopper looks one up
by id or SKU. That is served by a read model in the catalog query work; it is a
projection, **not** a second write aggregate. Write-side ownership and read-side
addressing are deliberately different shapes.

Why the variant, not the product, is the unit that matters downstream:
`ProductVariant` is **the sellable, stocked, priced unit**. Inventory stock,
pricing, and order lines all key on the **`variantId`** — the product is a
merchandising grouping; the variant is the thing with a price, a stock level,
and a place on an order line. ADR-025 records `variantId` as the forward
backbone key, and the inventory/retail columns that still carry a plain
`product_id` are reshaped onto it by later cross-context work.

### Files

| File | Contents |
|---|---|
| `domain/product.model.ts` | `Product` aggregate root: factories, getters, `addVariant`, `publish`, `archive`. |
| `domain/product-variant.model.ts` | `ProductVariant` child entity + its construction invariants. |
| `domain/product-status.enum.ts` | `ProductStatusEnum` (`draft / active / archived`). |
| `domain/product-variant-status.enum.ts` | `ProductVariantStatusEnum` (`active / archived`). |
| `domain/option-values.vo.ts` | `OptionValues` value object (non-empty map invariant). |
| `domain/dimensions.vo.ts` | `Dimensions` value object (non-negative integer mm). |
| `domain/catalog.exception.ts` | `CatalogDomainException` + `CatalogErrorCodeEnum`. |
| `domain/events/*.event.ts` | `VariantCreatedEvent`, `ProductPublishedEvent`, `ProductArchivedEvent`. |
| `domain/events/index.ts`, `domain/index.ts` | Barrels. |
| `domain/spec/*.spec.ts` | Two domain spec siblings. |

## 2. Field shapes

**`Product`** — `id: number | null`, `name: string` (required, non-empty),
`slug: string` (non-empty; globally unique at the repository), `description:
string` (may be empty), `status: ProductStatusEnum`, `variants:
ProductVariant[]`, `createdAt` / `updatedAt` (set by persistence).

**`ProductVariant`** — `id: number | null`, `productId: number | null`,
`sku: string` (non-empty; globally unique at the repository), `gtin: string |
null`, `optionValues: Record<string, string>` (non-empty map, e.g.
`{ color: 'red', size: 'M' }`), `weightG: number | null` (grams, non-negative
integer when present), `dimensionsMm: { l, w, h } | null` (mm), `status:
ProductVariantStatusEnum`, `createdAt` / `updatedAt`.

`optionValues` and `dimensionsMm` are promoted to value objects so their
invariants live in one place; the model exposes the raw map / record through its
getters so persistence and the read model do not have to know about the VO. The
`sku` and `slug` stay primitive-plus-invariant on the entity — their only rule
is "non-empty", which does not earn a dedicated type.

## 3. Invariants and where each is enforced

Invariants split into two homes. **The domain can only see itself** — it cannot
inspect other aggregates — so anything that requires a global view is a
repository-level guarantee, and the domain trusts the repository to reject a
clash.

| Invariant | Enforced where | How |
|---|---|---|
| `Product.name` non-empty | Domain | `Product` constructor throws `CatalogDomainException` |
| `Product.slug` non-empty | Domain | `Product` constructor throws |
| `Product.slug` **globally unique** | **Repository** | unique constraint; asserted in the register use-case spec via a repository double |
| `ProductVariant.sku` non-empty | Domain | `ProductVariant` constructor throws |
| `ProductVariant.sku` **globally unique** | **Repository** | unique constraint; asserted in the add-variant use-case spec |
| `optionValues` non-empty map of non-empty strings | Domain | `OptionValues` value object |
| `weightG` non-negative integer when present | Domain | `ProductVariant` constructor |
| `dimensionsMm` non-negative integer mm when present | Domain | `Dimensions` value object |
| `publish()` requires ≥1 variant | Domain | `Product.publish()` |

Every domain rejection raises a `CatalogDomainException` carrying a typed code
from `CatalogErrorCodeEnum` (e.g. `CATALOG_PRODUCT_PUBLISH_REQUIRES_VARIANT`).
This is the first concrete subclass of the framework-free `DomainException` base
from `@retail-inventory-system/common` — earlier aggregates threw plain `Error`.
The typed code lets a later application/presentation layer map a failure to an
HTTP status without string-matching messages, while the domain stays
transport-free.

The two **repository-level** uniqueness guarantees are intentionally *not*
asserted in the domain specs — the domain genuinely cannot enforce them. A
comment in `product.model.spec.ts` points the reader to where they are covered
(the use-case specs in the register/add-variant work).

## 4. The two lifecycle state machines

### `Product` — `draft / active / archived`

```
        publish()                 archive()
draft ───────────────▶ active ───────────────▶ archived
  (needs ≥1 variant)                              (terminal)
```

- **`draft → active`** via `Product.publish()`. Precondition enforced in the
  domain: **at least one variant**. (A second precondition — "≥1 active Price" —
  belongs to a future pricing capability and is a *documented seam*, not code:
  `publish()` enforces only the variant count, and the publish use case will
  *warn* rather than *block* on a price-less product until pricing lands. See
  ADR-025 §6.)
- **`active → archived`** via `Product.archive()`.
- **Rejected transitions** (each raises a `CatalogDomainException`):
  - `publish()` on a non-draft product (already active, or archived).
  - `archive()` on a non-active product (still draft, or already archived).
  - There is **no** `archived → draft` and **no** `archived → active` —
    archival is terminal for this work.

### `ProductVariant` — `active / archived`

Variants are born **`active`**. Variant-level archival is not a write operation
at this stage: the `archived` member is modelled so persistence and future flows
have the full vocabulary, but the only transition exercised today is
construction. There is therefore no variant transition method beyond the
constructor.

## 5. Three domain events and the `pullDomainEvents()` drain model

The aggregate records three `DomainEvent<number>` subclasses — the base
`aggregateId` is the product id:

| Event | Recorded by | Payload (beyond `aggregateId` = productId) |
|---|---|---|
| `VariantCreatedEvent` | `Product.addVariant(...)` | `variantId: number \| null`, `sku` |
| `ProductPublishedEvent` | `Product.publish()` | `slug`, `variantIds: number[]` |
| `ProductArchivedEvent` | `Product.archive()` | — |

There is deliberately **no `ProductCreated` event** — `Product.create(...)`
builds a draft and records nothing. The three events correspond to the three
*state-meaningful* transitions a downstream consumer cares about.

**The drain model.** `AggregateRoot` accumulates events in a private buffer;
`addDomainEvent(...)` pushes, and `pullDomainEvents()` returns the buffer and
clears it (pull-and-drain → exactly-once on subsequent saves). These are
**in-process** events: a `DomainEvent` subclass is **never serialized across
services**. The application use case calls `pullDomainEvents()` after the
repository round-trip and maps each domain event to a **versioned (`v1`) wire
event** — the wire DTOs and routing keys are defined in the catalog application
work, not here. This mirrors the `Order` aggregate
([ADR-013](../../adr/013-order-aggregate-and-cross-service-confirm.md)) and the
notification template.

**Why `VariantCreatedEvent.variantId` is nullable.** `addVariant` can run before
the product (and therefore the new variant) has ever been persisted, so the
variant id is `null` at record-time. The use case re-reads the concrete id from
the saved aggregate before emitting the wire event — a `null` never reaches a
subscriber. `ProductPublishedEvent`, by contrast, always runs against an
already-persisted product, so the aggregate filters out any null variant id and
the `variantIds` array is concrete.

## 6. Soft-delete via `status`, never `deletedAt`

Catalog rows are **never hard-deleted and never tombstoned with a timestamp.**
"Removing" a product means archiving it (`status = archived`). The reason is
referential: historical orders and stock rows reference variants by id, and an
id that resolved to a row yesterday must still resolve tomorrow — so an archived
row stays fully resolvable. The `deletedAt` column inherited from `BaseEntity`
is left **inert** on the catalog tables; anyone reading the schema should treat
`status` as the lifecycle source of truth. ADR-025 §2 records this decision.

A related, deliberate omission: there is **no optimistic-lock `version` column.**
Catalog is last-writer-wins — it is not in the no-oversell critical path (that
is the inventory `StockItem` reservation flow,
[ADR-012](../../adr/012-stock-aggregate-and-port-adapter.md)). ADR-025 §3 records
the trade-off.

## 7. Boundaries and tests

The domain imports only `@retail-inventory-system/ddd` and
`@retail-inventory-system/common` — no `@nestjs/*`, no TypeORM, no
`class-validator`. This is the `domain` element constraint from
[ADR-004](../../adr/004-adopt-hexagonal-architecture-per-service.md), enforced by
the `eslint-plugin-boundaries` rules
([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)) inside the
`yarn lint` gate.

Two spec siblings cover the model:

- `domain/spec/product.model.spec.ts` — the `draft → active → archived` walk;
  rejection of `publish()` on a non-draft and on a zero-variant product;
  rejection of `archive()` on a non-active product; `publish()` records
  `ProductPublishedEvent` with the right `variantIds`; `archive()` records
  `ProductArchivedEvent`.
- `domain/spec/product-variant.model.spec.ts` — non-empty `optionValues`;
  non-negative integer `weightG`; non-negative `dimensionsMm`; `addVariant`
  records `VariantCreatedEvent`.

Run them with `yarn test:unit`; the boundaries check rides `yarn lint`.
