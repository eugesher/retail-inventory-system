# 02 — Removing the inventory `product` stub

This document records a deliberate **removal**: the inventory microservice's
vestigial `product` table and its `Product` entity are deleted outright, and the
two foreign keys that anchored on `product (id)` are dropped with it. After this
change the shared `retail_db` schema has **no** `product` table and **no**
`Product` entity anywhere in the codebase. It is the conflict-resolution cleanup
that clears the `product` name so the catalog bounded context (see
[01 — The catalog microservice scaffold](./01-new-catalog-microservice-scaffold.md))
can later own a `product` table of its own.

## 1. Why the stub is removed up front

All services in this system share a single MySQL schema, `retail_db` (one
database, one migration history — see
[ADR-019](../../adr/019-typeorm-and-mysql-for-persistence.md)). In that shared
schema a table name is a global resource: only one table may be called
`product`.

The inventory service carried a `product` table that existed for one reason
only — to be the foreign-key target for `product_stock.product_id` (and,
incidentally, for `order_product.product_id` on the retail side). It held no
behaviour: the `Product` entity was four columns (`id`, `name`, `created_at`,
`updated_at`) with no use case reading or writing it through the domain. Product
**identity** belongs to the catalog context, which is being built out as its own
deployable. Leaving the inventory stub in place would block the catalog context
from ever creating its own `product` table under the shared schema.

The project's conflict-resolution rule is **deletion, never renaming**: we do
not move the stub aside to `product_legacy` or `product_old` (that would leave
two of everything and defeat the cleanup). We delete it and update every
reference in the same change. Because there is no deployed environment and no
data to preserve, a clean break is the cheapest path to the simplest final
state.

## 2. What was dropped

The removal spans the schema, the inventory persistence layer, and the test
seed:

- **The `product` table** — dropped by the forward migration
  `1780392162294-DropInventoryProductStub`.
- **Both foreign keys onto `product (id)`** — there were *two*, not one:
  - `FK_PRODUCT_STOCK_PRODUCT` on `product_stock.product_id` (inventory side).
  - `FK_ORDER_PRODUCT_PRODUCT` on `order_product.product_id` (retail side).
  `DROP TABLE product` fails while either constraint still references the table,
  so the migration drops both FKs first, then the table.
- **The `Product` entity** — `product.entity.ts` is deleted, along with its
  barrel re-export and its entry in the `stockEntities` array
  (`apps/inventory-microservice/src/modules/stock/infrastructure/persistence/index.ts`)
  and its `DatabaseModule.forFeature([...])` registration in `stock.module.ts`.
  The surviving stock entities — `ProductStock`, `ProductStockAction`, `Storage`
  — are untouched (see [ADR-012](../../adr/012-stock-aggregate-and-port-adapter.md);
  note the `product_stock` table keeps its name).
- **The `product.sql` seed** — deleted, and removed from the ordered
  `TestDbSeedUtil.seedFiles` list. The `product-stock.sql` and
  `order-product.sql` seeds keep their integer `product_id` values; with the FKs
  gone those columns are plain integers and the `INSERT IGNORE` rows still load
  without a parent `product` row to satisfy.
- **The retail order-create product-existence check** — the only runtime reader
  of the `product` table outside the migration was the retail repository method
  `findExistingProductIds`, which ran `SELECT id FROM product` to reject an
  order referencing an unknown product. With the table gone there is nothing for
  it to read, so the method, its port declaration, and the `OrderCreatePipe`
  that called it are removed. `POST /api/order` no longer validates product
  existence before persisting an order. See §4 for why this is the right state
  now and what restores the guarantee later.

## 3. Why `product_id` stays a plain integer

Both `product_stock.product_id` and `order_product.product_id` survive as plain
`BIGINT UNSIGNED` columns with **no** foreign key. This is intentional:

- There is no longer a `product` table for them to reference, and the catalog's
  product/variant tables do not exist yet.
- The inventory and retail models still key their stock and order lines on a
  product identifier; that identifier is now a bare integer rather than an FK
  into a co-located table.
- A later inventory change will **reshape** these columns onto a catalog
  `variantId` once the catalog owns product/variant identity. Until then the
  columns are deliberately unconstrained. Nothing is left dangling: with both
  FKs dropped, no column points at a table that no longer exists.

Keeping the columns (rather than dropping them) avoids a destructive,
hard-to-reverse schema change for data the model still needs; converting an
unconstrained integer into a typed reference later is a forward step, not a
rework.

## 4. The order-create existence check, and what restores it

Before this change, creating an order validated that every `productId` in the
request existed in the inventory `product` table, rejecting the order with
`400 Bad Request` otherwise. That check was a cross-context shortcut: retail
reached into an inventory-owned table to answer a question that really belongs
to the **catalog** (does this sellable thing exist?).

Removing the `product` table removes the only thing that check could read, so
the check is removed rather than re-pointed at a table that does not exist yet.
The trade-off is explicit: for now, `POST /api/order` accepts any
positive-integer `productId` and persists the order line. This is acceptable in
the current state because there is no catalog of valid products to validate
against — that catalog is being built. When the catalog read path is available,
order creation will validate the ordered identifier against the catalog
(against a published variant), restoring — and tightening — the guarantee that
was previously enforced against the inventory stub. That restoration is owned by
the work that wires retail to the catalog, not by this cleanup.

## 5. Migration mechanics

The change ships as a single hand-authored migration,
`1780392162294-DropInventoryProductStub`, created with `yarn migration:create`.
`synchronize` stays **off** in every environment
([ADR-019](../../adr/019-typeorm-and-mysql-for-persistence.md)); the schema only
ever moves through migration files.

`up()` drops in dependency order — constraints before the table they protect:

```sql
ALTER TABLE product_stock DROP FOREIGN KEY FK_PRODUCT_STOCK_PRODUCT;
ALTER TABLE order_product  DROP FOREIGN KEY FK_ORDER_PRODUCT_PRODUCT;
DROP TABLE product;
```

`down()` reverses it, recreating the table exactly as the initial schema
migration defined it, then re-adding both FKs (the table must exist before a
constraint can target it):

```sql
CREATE TABLE product ( id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, ... );
ALTER TABLE product_stock ADD CONSTRAINT FK_PRODUCT_STOCK_PRODUCT
  FOREIGN KEY (product_id) REFERENCES product (id);
ALTER TABLE order_product  ADD CONSTRAINT FK_ORDER_PRODUCT_PRODUCT
  FOREIGN KEY (product_id) REFERENCES product (id);
```

The migration is reversible against the **schema**: on a freshly migrated
(unseeded) database, `migration:run → migration:revert → migration:run` applies,
rolls back, and re-applies cleanly. Note that `down()` recreates an *empty*
`product` table; reverting against a database that already holds
`product_stock` / `order_product` rows with non-null `product_id` values would
fail when MySQL re-validates the recreated foreign keys against those orphaned
rows. That is the expected behaviour of a forward-only cleanup — the `down()`
exists to keep the migration well-formed and locally reversible, not to restore
a populated stub.

The initial schema migration that first created the `product` table is left
**immutable**: migration history is append-only, so the drop is expressed as a
new forward migration rather than by editing history
([ADR-019](../../adr/019-typeorm-and-mysql-for-persistence.md)).
