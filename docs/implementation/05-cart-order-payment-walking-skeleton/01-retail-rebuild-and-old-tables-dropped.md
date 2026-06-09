# Legacy retail order model torn down; retail rebooted order-free

This change removes the first-generation retail order model in one clean cut and
leaves the retail microservice **bootable but order-free** — it compiles, lints,
and boots listening on `retail_queue` with no message handlers. The rebuilt
checkout model (a mutable cart, an immutable order, payment, and addresses) lands
in subsequent changes; this one only tears down and records the decision.

## What was removed

- **Four tables** — `order`, `order_product`, `order_status`,
  `order_product_status`. The header/line pair held the orders; the two
  `*_status` tables were two-value reference lookups (`pending` / `confirmed`).
- **The retail `orders` module** — the `Order` aggregate that expanded each
  ordered line into **one `order_product` row per unit**, the two-value
  `OrderStatusVO` / `OrderProductStatusVO`, the create / confirm / get use cases,
  the TypeORM entities + mappers + repository, the RabbitMQ publisher, and the
  `OrderConfirmPipe`. The retail service's module wiring is reduced to an empty
  `DatabaseModule.forRoot([])` plus logging — the same "bootable, operation-free"
  shape the inventory service had between its model rebuilds.
- **The gateway `retail` module** — the `POST /api/order` and
  `PUT /api/order/:id/confirm` routes and the RPC adapter behind them are gone;
  the gateway boots with no order/cart routes.
- **The cross-service confirm→reserve caller** — the retail
  `INVENTORY_CONFIRM_GATEWAY` port, its adapter, and `ConfirmOrderUseCase`. Stock
  reservation already moved out of this RPC when inventory re-founded on running
  totals; the inventory `inventory.order.confirm` handler remains only as a typed
  deprecation stub (a reserved surface, see below).
- **The notification order consumer** — the `order-events.consumer.ts`
  subscriber and the `SendOrderNotificationUseCase` it drove (and their spec).
  The inventory low-stock consumer is untouched.
- **The legacy retail contracts** — the order DTOs, events, interfaces, and
  status enums in `libs/contracts/retail` are emptied; the package keeps a
  one-line placeholder export so it stays importable until the rebuilt contracts
  repopulate it.
- **The six `retail.order.*` routing keys** — `retail.order.create` / `.confirm`
  / `.get` / `.created` / `.confirmed` / `.cancelled` are retired from both
  `ROUTING_KEYS` and the mirrored `MicroserviceMessagePatternEnum` (the two stay
  value-for-value, asserted by the routing-keys spec).
- **The order seeds** — `order.sql` and `order-product.sql` and their entries in
  the test seed file list.

## Why a full rewrite, not an incremental refactor

The rebuilt model is a **structurally different shape**, not a tweak of the old
one:

- distinct **mutable `Cart`** and **immutable `Order`** aggregates (the legacy
  model had a single `Order` and no cart at all);
- **three orthogonal status axes** — lifecycle, payment, fulfillment — where the
  legacy model carried one two-value status on the header and one on each line;
- **money-minor line snapshots** captured at place-time (the legacy lines keyed a
  bare `product_id` and carried no money);
- a **`Payment`** aggregate and **snapshotted `Address`** rows that have no
  legacy counterpart.

An in-place migration would have to thread an `ALTER`-heavy path through four
legacy tables to reach a schema that shares almost nothing with the original —
more moving parts and more risk than dropping the tables outright. Because the
system has **no production data** (it has never been deployed), there is nothing
to preserve, so the clean cut is strictly cheaper and lower-risk. The rationale
and the alternatives weighed are recorded in
[ADR-028](../../adr/028-cart-order-payment-and-address-chain.md), which supersedes
[ADR-013](../../adr/013-order-aggregate-and-cross-service-confirm.md).

## The surviving `customer` table is not a retail table

Dropping the order tables leaves the `customer` table standing — but it is the
**gateway auth aggregate** (a `CHAR(36)` UUID-keyed `Customer`,
[ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)), not a
retail-side table. An earlier identity change already dropped the original
BIGINT-keyed retail customer along with the `order.customer_id` column and its
foreign key. The surviving `customer` table is the FK target the rebuilt
`order` / `cart` tables will reference, so it is deliberately **not** dropped
here.

## The kept inventory confirm surface

The inventory `inventory.order.confirm` handler, its `INVENTORY_ORDER_CONFIRM`
routing key, and the `IProductStockOrderConfirmPayload` wire contract are a
**reserved surface** — they stay. Only the retail-side *caller* is deleted. The
handler is a typed deprecation error today; the whole seam is removed when the
inventory-reservation capability lands
([ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md) owns
that). The kept contract previously imported a retail order interface and status
enum that were deleted here, so its per-line shape was **inlined** into the
inventory contract to make the reserved surface self-contained (the line's
`statusId` is now a plain string rather than the former enum).

## Migration & reversibility

The change ships as one hand-authored migration (`DropLegacyOrderTables`) with a
working `up`/`down` (`synchronize` stays off, per
[ADR-019](../../adr/019-typeorm-and-mysql-for-persistence.md)). `up` drops the
four tables in FK-dependency order (`order_product` before `order`). `down`
recreates them in dependency order and re-seeds the two-value status reference
rows — but recreates them in the shape they **actually had** at the start of this
change, not verbatim from their original definition: `order` comes back **without**
`customer_id` / its customer FK (an earlier identity change had already dropped
that column), and `order_product` keeps its `product_id` column but re-adds only
the FK onto `order` (the `product` table the other FK pointed at is long gone).
Because this migration is newer than the inventory rebuild's, a full revert runs
this `down` first — recreating `order_product` — before the inventory migration's
`down` recreates `product_stock` with its FK onto `order_product`, keeping that
foreign key valid. The migration applies, reverts, and re-applies cleanly.

## Tests

The unit suite stays green: the deleted use-case / domain / mapper specs went
with their sources, and the routing-keys spec drops the six retired keys. The
end-to-end suite is repointed: the order-creation system spec and the synthetic
order-notification spec are removed (the latter is re-added against the rebuilt
order-placed event by a later capability), and the auth suite's protected-route
sample is moved off the now-deleted `POST /api/order` onto the still-protected
`GET /api/inventory/locations`. The catalog / inventory / pricing / auth / iam
suites are unaffected — they exercise no order surface.
