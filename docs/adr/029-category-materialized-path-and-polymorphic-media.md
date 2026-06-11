# ADR-029: Category materialized path and polymorphic MediaAsset

- **Date**: 2026-06-11
- **Status**: Accepted

---

## Context

The catalog context ([ADR-025](025-catalog-product-and-variant-aggregate.md))
owns the merchandisable graph — `Product` (root) and its `ProductVariant`
children — plus a colocated pricing module
([ADR-026](026-price-append-only-ledger-and-tax-category.md)). Two merchandising
capabilities are still missing, and both are Product-side concerns:

1. **A browsable category hierarchy.** A shop organizes products into a tree
   (`Electronics → Phones → Smartphones`); a product belongs to one or more
   categories; a store-front browses a category and lists the products in it (and,
   typically, its descendants). Nothing in the catalog models this today.
2. **Media for products and variants.** A product card needs images; a specific
   variant (a red shirt vs. a blue one) needs its own. There is no place to
   attach an image URL to either.

This ADR records the **whole Stage-2 catalog-extension design** for both, so the
decisions are fixed before the code lands incrementally. The `Category`
aggregate (domain, persistence, migration) is realized first; the `MediaAsset`
aggregate and the operations on both follow in later catalog work. An ADR records
the decision; the code follows it (ADR-003).

The closest precedents are all in-repo: the catalog `Product`/`ProductVariant`
aggregate pair (ADR-025), the pricing module's opaque-`variantId` cross-module
coupling via parameterized SQL (ADR-026 §5), and the inventory `StockLevel`
running-totals foundation ([ADR-027](027-stocklevel-running-totals-and-stocklocation.md)).

## Decision

### 1. `Category` and `MediaAsset` are additional write aggregates inside the existing catalog module

Both are **Product-side merchandising concerns, not new bounded contexts.** They
join `apps/catalog-microservice/src/modules/catalog/` alongside `Product` —
no new deployable, no new queue, no `eslint-plugin-boundaries`
([ADR-017](017-architecture-lint-via-eslint-boundaries.md)) change. A category
tree and a product image are merchandising attributes of the catalog graph; spinning
up a separate context for either would buy only cross-service coupling for data
that is always read and written next to the product it describes
(ADR-004 / [ADR-009](009-port-adapter-at-the-gateway.md)).

### 2. Materialized `path` for the hierarchy; reparent = recompute self + one-transaction bulk subtree rebase; cycle detection in the domain

`Category extends AggregateRoot<number | null>` stores a **materialized path**:
each row carries the full root-to-self slug chain (`/electronics/phones`). The
hierarchy questions a store-front asks are read-shallow and the tree mutates
rarely, so the path is the cheapest representation:

- **A subtree read** ("everything under Electronics") is a single indexed
  `path LIKE '/electronics%'` — no recursion, no join fan-out.
- **An ancestry test** is a pure string-prefix check. `isAncestorOfOrSelf(other)`
  is `other.path === this.path || other.path.startsWith(this.path + '/')`. The
  trailing `/` is load-bearing: it makes `/a` **not** an ancestor of `/ab`, so a
  sibling-prefix never registers as an ancestor.

**The slug is a path segment, so its invariant is stricter than `Product.slug`.**
A category slug must be **kebab-case** (`^[a-z0-9]+(?:-[a-z0-9]+)*$`) — not merely
non-empty as `Product.slug` is — because a slug containing a space or a `/` would
corrupt every descendant's `path`. The pattern is re-declared in the catalog
`domain/` (the domain imports nothing from the gateway DTO that carries the same
literal).

**Reparenting splits across two layers.** Moving a category recomputes **its own**
`parentId` + `path` from the new parent (`Category.reparentUnder(newParent)`; a
`null` parent demotes it to a root). The **descendants'** path rewrite is **not**
the model's job — each category row is its own aggregate, so the subtree rebase is
a repository-transaction concern: `ICategoryRepositoryPort.reparentSubtree(category,
oldPath)` runs, in **one** `manager.transaction`, the moved-row `UPDATE` and a
single bulk `UPDATE category SET path = CONCAT(?, SUBSTRING(path, LENGTH(oldPath)+1))
WHERE path LIKE ?` over the old subtree (the `PricingTypeormRepository.appendPrice`
precedent — the transaction lives inside the repository method, no `ITransactionPort`
needed). **Cycle detection lives in the domain:** `reparentUnder` rejects with
`CATEGORY_CYCLE` when `this.isAncestorOfOrSelf(newParent)` — you cannot move a
category under itself or one of its own descendants.

**Alternatives rejected:**

- **Closure table** (a second `category_closure(ancestor, descendant, depth)`
  table) — gives O(1) subtree reads too, but at the cost of a second table and a
  fan-out write (one row per ancestor×descendant pair) on every insert/move, for a
  hierarchy that is read-shallow and write-rare. The materialized path gets the
  same read shape from one indexed column.
- **Nested sets** (left/right boundary numbers) — subtree reads are a range query,
  but **every insert rebalances** a large swath of the tree's boundary numbers. The
  write cost is wrong for a structure edited by hand.
- **Per-query recursive CTE** (no stored hierarchy column) — pushes the tree walk
  into every read and stores nothing to index or inspect. The materialized path
  keeps the resolved hierarchy on the row, greppable and indexable.

### 3. `product_categories` membership is a bare N↔M join maintained at the repository

A product belongs to many categories; a category lists many products. The
membership is a **bare join table** — composite PK `(product_id, category_id)`, no
surrogate id, no timestamps, **no TypeORM entity.** The category repository
maintains it with **parameterized SQL through the injected manager** and idempotent
`INSERT IGNORE` (the `product_variant.tax_category_id` precedent from pricing,
ADR-026 §5). **Neither `Product` nor `Category` holds the membership in memory** —
loading either side's collection into the aggregate would bloat both write models
with a relationship that browse reads, not the write path, cares about. The
membership read/write methods land with the reclassify capability; this foundation
ships only the table.

### 4. Polymorphic `MediaAsset` — one table, an `ownerType`/`ownerId` pair, no owner FK

A `MediaAsset` attaches to **either** a product **or** a variant. Rather than two
near-identical child tables, it is **one polymorphic table**: `ownerType ∈
{product, product-variant}` + an opaque `ownerId`, a `uri`, a `sortOrder`, a
`status`, and a composite `(owner_type, owner_id, sort_order)` index for the
ordered per-owner read. There is **no foreign key** on the polymorphic owner (a
single column cannot FK two tables); the use cases compensate with an existence
check against the owning aggregate before attaching.

**Opaque-URI policy:** `uri` is an **already-uploaded** `https://…` / `s3://…`
string. Upload pipelines, signed URLs, and CDN invalidation are deliberately out
of scope — a future capability, not this one.

**Alternative rejected:** two per-owner join/child tables
(`product_media` + `product_variant_media`). It duplicates the schema and every
operation (attach/detach/reorder/list, twice) for an entity whose behaviour never
varies by owner type. The polymorphic single table trades a database-enforced FK
(recovered by a use-case existence check) for one set of operations.

### 5. Soft-delete via `status` for both aggregates

`Category` and `MediaAsset` both carry a `status` (`active` / `archived`); the
`deletedAt` column inherited from `BaseEntity` stays **inert** (the ADR-025
convention). Archival is the lifecycle path — a hard delete is never issued.
**Detach-media is a status flip**, preserving the row for anything that captured the
asset id historically; archiving a category likewise keeps its id resolvable. The
category self-FK is `ON DELETE SET NULL` purely as a schema-level safety net (a
hand-deleted row demotes its children to roots rather than blocking or cascading);
no operation exercises it.

### 6. No domain events for category/media edits

Neither aggregate is in the must-emit set. `Category` records **nothing** — unlike
`Product` it never calls `addDomainEvent`, and `pullDomainEvents()` always drains
empty. `MediaAsset` is the same. A category reparent or a media attach has no
cross-service consumer today; a future cache-invalidation event (e.g. "a category
moved, re-warm the browse cache") would be **additive** and gets its own decision
when a consumer exists.

### 7. The publish "≥1 active MediaAsset" recommendation is a soft warning, not a block

A published product *should* arguably have at least one image. But unlike the hard
`PRODUCT_PUBLISH_REQUIRES_PRICE` gate (ADR-025 §6 / ADR-026), the media
recommendation becomes a **soft warning in the publish response** (`warnings[]`),
never a block — a shop may legitimately publish a price-bearing, image-less product
and add the image moments later. The check lives in the **publish use case** (the
domain cannot see media); a price-less product is a hard 409, an image-less product
is a soft warning. The contrast is deliberate: a missing price breaks checkout, a
missing image is a merchandising nicety.

### 8. Per-aggregate repository ports within the one module

The catalog module already binds `CATALOG_REPOSITORY` (Product) and, from pricing,
`PRICING_REPOSITORY`. `Category` gets its **own** `CATEGORY_REPOSITORY` port, and
`MediaAsset` will get `MEDIA_ASSET_REPOSITORY` — **a port per aggregate seam**, the
`ACTIVE_PRICE_PROBE` precedent. This keeps `ICatalogRepositoryPort` from swelling
into a module-wide grab-bag of unrelated methods; each port is the contract for
exactly one aggregate's persistence, and the domain types it returns never leak a
`typeorm` import (ADR-017).

## Alternatives considered

1. **A separate `category` (or `media`) bounded context / microservice.** Rejected
   (§1). Both are merchandising attributes of the catalog graph, always read and
   written next to a product; a separate context buys only cross-service coupling.
2. **Closure table / nested sets / recursive CTE for the hierarchy.** Rejected
   (§2). Each loses to the materialized path on the read-shallow, write-rare shape
   of a category tree — a closure table on write fan-out, nested sets on insert
   rebalancing, a CTE on having nothing stored to index.
3. **Loading category membership into the `Product` (or `Category`) aggregate.**
   Rejected (§3). The N↔M membership is a browse concern; folding either side's
   collection into the write aggregate bloats the write model. A bare join
   maintained at the repository keeps both aggregates lean.
4. **Two per-owner media tables instead of one polymorphic table.** Rejected (§4).
   Duplicate schema + duplicated operations for an entity whose behaviour is
   owner-type-agnostic.
5. **A hard publish gate on media (mirroring the price gate).** Rejected (§7). A
   missing image does not break checkout; a soft warning communicates the
   recommendation without blocking a legitimate publish.
6. **One catalog-wide repository port.** Rejected (§8). A port per aggregate seam
   keeps each contract focused and matches the existing `ACTIVE_PRICE_PROBE`
   precedent.

## Consequences

- The catalog module gains a `Category` write aggregate (framework-free domain,
  materialized-path semantics, cycle detection), its `CATEGORY_REPOSITORY` port +
  `CategoryTypeormRepository` (including the one-transaction subtree rebase), and
  the `category` + `product_categories` tables. The catalog microservice boots with
  the new entity registered; the `MediaAsset` half and the operations on both follow
  in later catalog work.
- **Reparenting is split** between the domain (recompute self + reject a cycle) and
  the repository (rebase the subtree in one transaction). A reparent response can
  surface the descendant-rewrite count the repository returns.
- The `product_categories` join exists but is dormant until the reclassify
  capability adds the membership methods; no join entity is introduced.
- The `BaseEntity.deletedAt` column is inherited by `category` (and later
  `media_asset`) but left inert; `status` is the lifecycle source of truth.
- The polymorphic `media_asset` design (no owner FK, use-case existence checks,
  opaque URI) is fixed here so the later media build has no design latitude to
  re-litigate.
- The soft media-warning vs. hard price-gate contrast on publish is recorded, so the
  later publish change knows which side of the line media sits on.

## References

- [ADR-025](025-catalog-product-and-variant-aggregate.md) — the catalog `Product`
  aggregate this model joins (`AggregateRoot` + `status`-driven soft-delete;
  lifecycle enums in `domain/`; repository-level slug uniqueness; the first concrete
  `CatalogDomainException`). `Category` follows its template and diverges only on the
  kebab-case slug, the no-events stance, and the materialized path.
- [ADR-026](026-price-append-only-ledger-and-tax-category.md) — the opaque-`variantId`
  cross-module coupling via parameterized SQL (the `product_categories` and
  `tax_category_id` precedent) and the transaction-inside-the-repository-method
  pattern (`appendPrice`, mirrored by `reparentSubtree`).
- [ADR-004](004-adopt-hexagonal-architecture-per-service.md) /
  [ADR-009](009-port-adapter-at-the-gateway.md) — the per-module hexagonal layout
  and the "no new bounded context for a Product-side concern" stance.
- [ADR-017](017-architecture-lint-via-eslint-boundaries.md) — the boundaries lint
  that keeps the domain framework-free and forbids a `typeorm` leak in a port.
- [ADR-019](019-typeorm-and-mysql-for-persistence.md) — `BaseEntity`, the
  hand-authored migration workflow, `SnakeNamingStrategy`, and `synchronize` off.
- [01 — Category hierarchy and the materialized path](../implementation/06-catalog-category-and-media/01-category-hierarchy-and-materialized-path.md)
  — the implementation companion to this decision.
