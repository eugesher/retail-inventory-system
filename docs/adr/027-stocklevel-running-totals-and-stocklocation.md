# ADR-027: `StockLevel` running totals and location-aware `StockLocation`

- **Date**: 2026-06-08
- **Status**: Accepted (supersedes [ADR-012](012-stock-aggregate-and-port-adapter.md))

---

## Context

[ADR-012](012-stock-aggregate-and-port-adapter.md) modelled inventory as an
append-only `product_stock` ledger: every stock movement was a signed-delta row
against a `(productId, storageId)` pair, and the current balance was derived on
every read with a `SUM(quantity) ... GROUP BY storage_id` aggregation
([ADR-002](002-redis-cache-aside-product-stock.md) added Redis cache-aside
specifically to avoid repeating that aggregation). The model had three problems
the new merchandising foundation makes acute:

1. **Read cost grows with history.** Aggregation cost scales with the number of
   ledger rows, not the number of distinct stock positions. A long-lived SKU
   accumulates rows forever; the balance is always recomputed.
2. **No per-location running totals.** The ledger has no notion of a *location*
   as a first-class entity (only an opaque `storage_id` string FK to a thin
   `storage` table) and no maintained per-location on-hand/allocated/reserved
   counters — everything is re-derived.
3. **Keyed on `productId`, not `variantId`.** The catalog foundation
   ([ADR-025](025-catalog-product-and-variant-aggregate.md)) established the
   **variant** as the unit that is stocked, priced, and sold. Inventory still
   keyed on the product header; the standalone inventory `product` stub was
   already dropped, leaving `product_stock.product_id` as a plain integer with
   no referent.

No production data exists yet, so the model can be replaced in one clean cut
rather than migrated in place.

## Decision

### 1. Running totals replace the ledger-as-source-of-truth

Inventory persists per-location **`StockLevel` running totals** —
`quantityOnHand`, `quantityAllocated`, `quantityReserved` — instead of summing
a delta ledger. A read is a point lookup of one row per `(variantId,
stockLocationId)`; `available = onHand − allocated − reserved` is a pure getter
on the aggregate. The write pattern (mutate a counter) is comparatively light
and the read pattern is heavy, so maintained totals fit the workload better
than re-aggregation.

The audit trail the ledger gave for free becomes the responsibility of a
dedicated movement record (a `StockMovement`-style log) owned by the later
inventory-reservation capability; it is **not** the source of truth for the
current balance.

### 2. `StockLocation` is location-aware at the universal core

A first-class `StockLocation` aggregate (`stock_location` table) models the
physical or virtual place stock is held: `id` (a caller-assigned string PK such
as `default-warehouse`), `name`, `code`, `type`
(`warehouse`/`store`/`dropship-virtual`), optional `address` (JSON) and `gln`
(13-digit Global Location Number), and an `active` flag. Exactly one default
location (`default-warehouse`) is **auto-provisioned** by the migration, made
idempotent with `INSERT ... ON DUPLICATE KEY UPDATE` (the Vendure-style "always
a default location" stance). `code` global uniqueness is repository-level (a
UNIQUE constraint), not model-enforced — mirroring the catalog `slug`/`sku`
convention ([ADR-025](025-catalog-product-and-variant-aggregate.md)).

**Soft-delete is via the `active` flag, never a `deletedAt` timestamp.** The
inherited `BaseEntity.deletedAt` column stays inert, exactly as the catalog and
pricing tables leave it.

### 3. A `version` optimistic-concurrency column ships now

`stock_level` carries a `version` column (TypeORM `@VersionColumn()`); the
`StockLevel` aggregate bumps its in-memory `version` on every mutation. The
no-oversell invariant this token guards — reservation/allocation must not drive
`available` negative under concurrency — is enforced by the later
inventory-reservation + concurrency-hardening capabilities. Shipping the column
from the start makes that retrofit **non-destructive**: no future `ALTER TABLE`
on a populated table.

The aggregate exposes only `changeOnHand(delta)` (the one mutation this
foundation needs, rejecting a negative result and bumping `version`) plus a
`StockLevel.initialAt(variantId, stockLocationId)` zeroed factory.
`allocate`/`reserve`/`release` are intentionally **absent** — shipping them now
would be dead, untested code.

### 4. All inventory keys move from `productId` to `variantId`

`stock_level.variant_id` is a real cross-service FK to `product_variant(id)`
(`ON DELETE RESTRICT`); both tables share the one MySQL connection. The
inventory domain treats `variantId` as an **opaque** link and never imports the
catalog `ProductVariant` — the only coupling is the FK, exactly as pricing
couples to `product_variant` ([ADR-026](026-price-append-only-ledger-and-tax-category.md)).
The `StockLevelEntity` maps `variant_id` as a plain BIGINT scalar with no
`@ManyToOne`. Non-negativity is also backed by three `CHECK` constraints on
MySQL 8.4.

### 5. The cache *mechanism* is preserved; only the cached *value shape* changes

The cache-aside mechanism (ADR-002 / [ADR-006](006-cache-aside-via-libs-cache.md)
/ [ADR-016](016-cache-aside-generalized.md) / [ADR-021](021-cache-single-flight-and-ttl-jitter.md)
/ [ADR-022](022-cache-keys-tenant-and-schema-version.md) /
[ADR-023](023-cache-invalidate-post-commit-by-type.md)) stays. What changes is
the cached value: a `StockLevel` projection keyed on the variant, not a
`SUM`-aggregate keyed on the product. The `StockCache` rebuild and the
cache-key-version bump that records the new value shape land with the
availability read path (a later capability); this foundation deletes the old
`StockCache` and leaves `cache-keys.ts` at `v1`.

### 6. Supersedes ADR-012

This decision supersedes [ADR-012](012-stock-aggregate-and-port-adapter.md)
(`StockItem` / `product_stock`). ADR-012's `Status` is flipped to
`Superseded by ADR-027` with a one-line pointer (the only edit an accepted ADR
receives — [ADR-003](003-record-architecture-decisions.md)). The
`IStockEventsPublisherPort` and `ITransactionPort` introduced by ADR-012 are
retained; the repository port is rewritten to the new domain-typed surface.

## Alternatives Considered

1. **Keep the append-only ledger as the source of truth.** Rejected: read
   aggregation cost grows with history, and the ledger has no per-location
   running totals. An audit log of movements is still valuable, but as a
   separate record, not the balance authority.
2. **Make the default location optional (no auto-provisioned warehouse).**
   Rejected as a migration hazard: every stock level needs a location FK, so a
   schema with zero locations forces a special-case "unassigned" path until the
   first warehouse is created. One always-present default is simpler and is the
   established Vendure stance.
3. **Soft-delete locations via a `deletedAt` timestamp.** Rejected: `active` is
   the lifecycle flag (a location can be deactivated and reactivated); a
   delete-timestamp implies an irreversible removal and collides with TypeORM's
   `deleted_at IS NULL` filtering. `deletedAt` stays inert, as elsewhere.
4. **Defer the `version` column until reservation lands.** Rejected: adding an
   optimistic-lock column to a populated table later is a destructive
   `ALTER TABLE`; shipping it now is free and makes the retrofit clean.

## Consequences

- `product_stock`, `product_stock_action`, and `storage` are dropped;
  `stock_location` + `stock_level` replace them in one migration that also
  auto-provisions `default-warehouse`. The migration `down` restores the prior
  schema cleanly (it recreates the prior `product_stock` shape — which had
  already lost its `product` FK — and re-seeds the `storage` / action rows).
- The inventory microservice boots with only the `inventory.order.confirm`
  deprecation stub (a typed `RpcException`); the read/availability RPC, the
  gateway endpoints, the auto-init consumer, and Receive/Adjust land in later
  capabilities. The `inventory.product-stock.get` routing key is removed.
- `IStockRepositoryPort` is rewritten to `findLocation` / `listLocations` /
  `findStockLevel` / `findStockLevelsByVariant` / `saveStockLevel` (domain types
  only, no TypeORM leak — [ADR-017](017-architecture-lint-via-eslint-boundaries.md)).
- The cross-service confirm contract (`IProductStockOrderConfirmPayload`) is
  kept so the retail confirm flow still type-checks; the whole confirm seam is
  removed when the inventory-reservation capability lands.

## References

- [ADR-012](012-stock-aggregate-and-port-adapter.md) — the superseded
  `StockItem` / `product_stock` model.
- [ADR-002](002-redis-cache-aside-product-stock.md) /
  [ADR-016](016-cache-aside-generalized.md) /
  [ADR-023](023-cache-invalidate-post-commit-by-type.md) — the cache-aside
  mechanism preserved (only the cached value shape changes).
- [ADR-025](025-catalog-product-and-variant-aggregate.md) — `variantId` as the
  downstream backbone key and the repository-level-uniqueness convention.
- [ADR-026](026-price-append-only-ledger-and-tax-category.md) — the
  opaque-`variantId`-FK precedent (a sibling cluster keyed on the variant).
- [ADR-019](019-typeorm-and-mysql-for-persistence.md) — the migration workflow
  (`synchronize` off) and the `BaseEntity` ID strategy this diverges from for
  the string-PK location.
