# Old inventory tables dropped; the new `stock_location` + `stock_level` schema

This change replaces the inventory microservice's persistence foundation in one
clean cut. The append-only stock ledger is gone; per-location running totals
take its place, keyed on the catalog **variant** rather than the product.

## What was removed, and why

Three tables were dropped:

- **`product_stock`** — the append-only delta ledger. Each row recorded a signed
  `quantity` change against a `(product_id, storage_id)` pair, so the current
  balance was only obtainable with a `SUM(quantity) ... GROUP BY storage_id`
  aggregation. Aggregation cost grew with the number of historical rows, not the
  number of distinct stock positions — the wrong cost curve for a read-heavy
  warehouse workload.
- **`product_stock_action`** — a lookup table classifying each ledger row
  (`manual-stock-update`, `order-product-confirm`). It only had meaning while
  the ledger existed.
- **`storage`** — a thin table (`id`, `name`) the ledger's `storage_id` pointed
  at. It is superseded by the richer, first-class `stock_location`.

The standalone inventory `product` table was **already** removed by the catalog
work (the catalog microservice now owns `product` + `product_variant`), which is
why the dropped `product_stock` no longer carried a `product` foreign key — only
FKs onto `storage`, `product_stock_action`, and `order_product`.

## What was added

Two tables replace them:

- **`stock_location`** — a first-class location. Columns: `id` (a caller-assigned
  `VARCHAR(64)` string PK, e.g. `default-warehouse`), `name`, `code` (globally
  unique), `type` (`warehouse`/`store`/`dropship-virtual`), `address` (JSON,
  nullable), `gln` (13-digit Global Location Number, nullable), `active`, plus
  the standard `created_at` / `updated_at` / `deleted_at`. `deleted_at` is inert
  — deactivation flips `active`, never the timestamp.
- **`stock_level`** — per-location running totals for one variant. Columns: a
  generated `BIGINT` `id`, `variant_id` (`BIGINT`), `stock_location_id`,
  `quantity_on_hand` / `quantity_allocated` / `quantity_reserved` (each `INT`,
  non-negative), a `version` optimistic-concurrency column, and the standard
  timestamps. A `UNIQUE (variant_id, stock_location_id)` constraint makes "one
  level per variant per location" a schema invariant; an index on
  `stock_location_id` supports per-location queries. Three `CHECK` constraints
  back the non-negative-quantity invariants (MySQL 8.4 enforces `CHECK`).

## Running totals over a ledger-as-source-of-truth

A maintained-totals model stores the *answer* (current on-hand/allocated/reserved
per position) and pays the cost on **write** (mutate a counter). A
ledger-as-source-of-truth stores the *inputs* (every delta) and pays the cost on
**read** (re-aggregate). Stock is read far more often than it is mutated, and a
position's row count under a ledger is unbounded over its lifetime — so running
totals fit the workload. The audit value a ledger gave for free is preserved
separately: a dedicated stock-movement log (owned by the later
inventory-reservation capability) records every change, but it is **not** the
authority for the current balance.

See [02-default-stocklocation-auto-provision.md](02-default-stocklocation-auto-provision.md)
for why exactly one default location is auto-provisioned, and
[03-stocklevel-aggregate-and-version-column.md](03-stocklevel-aggregate-and-version-column.md)
for the `StockLevel` aggregate and the `version` token.

## `productId` → `variantId`

Every inventory key moves from the product header to the catalog **variant** —
the unit that is actually stocked, priced, and sold (see
[../02-catalog-product-and-variant/](../02-catalog-product-and-variant/) and
[ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md)).
`stock_level.variant_id` is a real cross-service foreign key to
`product_variant(id)` (`ON DELETE RESTRICT`): both tables live on the one MySQL
connection, so referential integrity is enforced at the database. At the code
level the coupling is *only* that FK — the inventory domain treats `variantId`
as an opaque number and never imports the catalog entity, exactly as pricing
couples to the variant ([ADR-026](../../adr/026-price-append-only-ledger-and-tax-category.md)).

## Migration & reversibility

The change ships as one hand-authored migration
(`ReplaceProductStockWithStockLevelAndLocation`) with a working `up`/`down`
(`synchronize` stays off, per [ADR-019](../../adr/019-typeorm-and-mysql-for-persistence.md)).
`up` drops the three old tables, creates the two new ones, and auto-provisions
the default location idempotently. `down` restores the prior schema faithfully:
it recreates `storage`, `product_stock_action`, and `product_stock` (the latter
in its pre-change shape — with the `order_product_id` FK but **no** `product`
FK, matching the state the catalog work had already left it in) and re-seeds the
`head-warehouse` and action rows. The migration applies, reverts, and re-applies
cleanly; the default-location insert is idempotent on re-run.

The rationale and the alternatives weighed are recorded in
[ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md), which
supersedes [ADR-012](../../adr/012-stock-aggregate-and-port-adapter.md).
