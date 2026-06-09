# Cart and CartLine — the mutable side of the rebuilt checkout

This change stands up the retail microservice's **mutable shopping cart**: the
`Cart` aggregate root, its `CartLine` children, their two tables, the repository
contract, the cart wire contracts (status enum + view DTOs), and the
reserved-surface `retail.cart.*` event routing keys. It is **foundation only** —
there are no cart use cases, no message handlers, and no gateway routes yet; the
retail microservice boots with the `cart` module registered but serving nothing.
The cart operations and their HTTP gateway, together with guest-cart promotion,
land in a later capability (see [Guest carts](#guest-carts-a-deferred-decision)).

The decision this implements is recorded in
[ADR-028](../../adr/028-cart-order-payment-and-address-chain.md).

## Why a cart distinct from the order (the two-aggregate decision)

A storefront checkout has two fundamentally different records:

- a **mutable working set** the shopper edits freely — add a variant, bump a
  quantity, drop a line; and
- an **immutable record** of what was actually bought, at the prices that applied
  at the instant of purchase.

These are modelled as **two distinct aggregates in one bounded context**: a
mutable **`Cart`** (this change) and an immutable **`Order`** (a later change).
Placing an order is a **one-shot conversion** — at place-time the cart's lines are
snapshotted into order lines and the cart is marked `converted`.

Keeping them separate is what protects the historical record. If a single
aggregate were edited in place from "shopping" through "placed", a later edit of
the working set could rewrite the purchased record — a shopper re-opening a
converted cart and changing a quantity would silently corrupt the order's audit
trail. Because the placed order is a **copy** taken at place-time, no subsequent
cart edit can reach it: the two graphs share no rows. (A converted cart is also
frozen — its mutators reject — so the cleaner of the two guards applies from both
sides.) The alternative, a single mutable order edited in place, was rejected for
exactly this reason.

## The `Cart` / `CartLine` model

Both live at `apps/retail-microservice/src/modules/cart/domain/` and are
framework-free (no `@nestjs/*`, no `typeorm`, no `class-validator` on the model —
[ADR-004](../../adr/004-adopt-hexagonal-architecture-per-service.md)).

### `Cart` (aggregate root)

- **Identity** — a `CHAR(36)` UUID generated in-app by `Cart.create(...)` (the
  "caller-assigned" path), so the id is concrete from the moment the cart exists.
  This diverges from the project's auto-increment integer PK; it lets the cart id
  travel in the create event and in URLs before any DB round-trip.
- **Status machine** — `active → converted` (placement) or `active → abandoned`
  (the later purge capability). Both transitions are **terminal**; there is no way
  back to `active`. A non-`active` cart is frozen: every line mutator rejects it.
- **Lifecycle factories** — `create({ customerId, currency, expiresAt? })` opens a
  new `active`, empty, `version 0` cart and records a `CartCreatedEvent`;
  `reconstitute(props)` is the load path (any status / version, records nothing).
- **Mutators** — `addLine`, `changeLineQuantity`, `removeLine`, `markConverted`,
  `markAbandoned`. **Each advances the `version` token** (so "version bumps on
  every mutation" is observable) and the line mutators each record a matching
  domain event drained via `pullDomainEvents()`.
- **`customerId`** — the gateway customer UUID, **nullable**: a guest cart has no
  customer, and a registered shopper's cart carries their id. (How a guest cart is
  later promoted to a registered one is the deferred question below.)
- **`currency`** — a non-empty 3-letter code, validated at construction and
  **immutable** thereafter (a getter with no setter). A cart never mixes
  currencies; line price snapshots carry the same code.
- **`total`** — a pure getter returning `{ subtotalMinor, currency }`, the sum of
  each line's `unitPriceSnapshotMinor × quantity`. Money is always **minor units**
  (integer cents), never a float.

#### `addLine` increments an existing line

When a variant already has a line, `addLine` **increments that line's quantity**
rather than appending a duplicate. This is the cleaner cart UX (one row per
variant) and is what the later operations assume. On the increment path the
existing line's **price snapshot is preserved** — the line is never re-priced by a
repeat add; the incoming snapshot fields are used only when a brand-new line is
created.

### `CartLine` (child entity)

A line is a child of the `Cart` root — never persisted or mutated on its own; the
root adds, mutates, and validates it. Invariants, all enforced at construction:
`variantId` a positive integer; `quantity` a positive integer (`> 0` — a `0` is
**rejected**, removal is the explicit operation); `unitPriceSnapshotMinor` a
non-negative integer; `currencySnapshot` non-empty.

The snapshot fields (`unitPriceSnapshotMinor`, `currencySnapshot`) are
**captured at add-time and stay stable** when sibling lines mutate — changing line
B's quantity never re-prices line A. The unit spec asserts this directly.

`variantId` is the **opaque downstream backbone key** ([ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md)
/ [ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md)): the
retail domain never imports the catalog `ProductVariant`; the only coupling is the
foreign key in persistence.

### The `version` optimistic-concurrency token

`Cart` carries a `version` column **now**, even though no concurrency guard
consumes it yet. The aggregate advances it on every mutation; TypeORM's
`@VersionColumn` owns the persisted value. Shipping the column up front keeps a
later concurrency-hardening retrofit non-destructive — adding an optimistic-lock
column to a populated table is an `ALTER TABLE` on live data, the same
forward-provisioning reasoning the inventory `stock_level.version` used.

## The `cart` / `cart_line` schema

One migration creates both tables (`synchronize` stays off —
[ADR-019](../../adr/019-typeorm-and-mysql-for-persistence.md)):

| Table | Key columns | Notes |
| --- | --- | --- |
| `cart` | `id CHAR(36)` PK, `customer_id CHAR(36)` NULL, `currency CHAR(3)`, `status ENUM('active','abandoned','converted')`, `expires_at`, `version INT`, timestamps + inert `deleted_at` | `FK_CART_CUSTOMER → customer(id) ON DELETE SET NULL` (a deleted customer leaves a customerless cart, never cascades it away) |
| `cart_line` | `id BIGINT UNSIGNED` PK, `variant_id BIGINT UNSIGNED`, `quantity INT`, `unit_price_snapshot_minor BIGINT`, `currency_snapshot CHAR(3)`, timestamps + inert `deleted_at` | `FK_CART_LINE_CART → cart(id) ON DELETE CASCADE`, `FK_CART_LINE_VARIANT → product_variant(id) ON DELETE RESTRICT`, `CHECK (quantity > 0)`, index on `cart_id` |

All four bounded contexts share the one MySQL database, so `cart.customer_id` and
`cart_line.variant_id` are **real cross-context foreign keys** onto the gateway
`customer` aggregate ([ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md))
and the catalog `product_variant` respectively. The CHAR(36) columns + both tables
are `utf8mb4_unicode_ci` so the FK collations match the referenced columns.

`deleted_at` exists on **both** tables because the entities extend `BaseEntity`
(TypeORM appends `deleted_at IS NULL` to every `find`, so the column must exist),
but it stays **inert** — a cart is purged by status, a removed line is
hard-deleted by the repository; neither is soft-deleted. (`cart_line.deleted_at`
is the one addition over the otherwise-minimal line table — it is required for the
`BaseEntity`-driven reads to work.)

### Persistence shape

`CartEntity` overrides `BaseEntity`'s integer PK with the `CHAR(36)` string PK
(the same `Omit<BaseEntity, 'id'>` technique the inventory `StockLocationEntity`
uses). `CartLineEntity` maps the owning cart through the `@ManyToOne` relation
alone — there is **no separate `cart_id` scalar column on the entity**. A
string-FK twin-mapping (a `char(36)` scalar *and* a join column on one `cart_id`)
trips TypeORM's metadata validator because the two disagree on column type; the
catalog `product_variant`'s twin-mapping works only because its FK is numeric. A
child entity does not carry its parent's id in the domain anyway, so the
relation-only mapping is also the truer shape.

`CartTypeormRepository` is the single `@InjectRepository` site. Its `save` runs in
one transaction: it upserts the root by the caller-assigned UUID (an `INSERT` when
absent, a `version`-checked `UPDATE` when present), then **reconciles the lines** —
deleting the cart's rows the aggregate no longer holds (a removed line) before
upserting the survivors and inserting new ones — and finally **re-reads the saved
graph** so generated `cart_line.id`s come back concrete (the
`CatalogTypeormRepository` idiom). TypeORM cascade covers only insert/update,
never remove, so line removal is reconciled explicitly. The repository returns
domain types only — no TypeORM type leaks past it
([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)).

## Wire contracts and reserved-surface events

The cart contracts live in `libs/contracts/retail` (plain TypeScript; Swagger
decorators on DTOs are the documented lib-contracts exception —
[ADR-005](../../adr/005-split-shared-common-into-bounded-libs.md)):

- **`CartStatusEnum`** (`active` / `abandoned` / `converted`) — a wire contract,
  not an internal domain enum, because it surfaces on the view DTO and the
  created event.
- **`CartView` / `CartLineView`** — the RPC/HTTP response shapes (the view carries
  `subtotalMinor` and each line a `lineSubtotalMinor`, both projections of
  `Cart.total`).
- **Four event interfaces** — `IRetailCartCreatedEvent`,
  `IRetailCartLineAddedEvent`, `IRetailCartLineRemovedEvent`,
  `IRetailCartLineQuantityChangedEvent`, each `eventVersion: 'v1'`.

The matching routing keys — `retail.cart.created`, `retail.cart.line-added`,
`retail.cart.line-removed`, `retail.cart.line-quantity-changed` — are added to
`ROUTING_KEYS` and the mirrored `MicroserviceMessagePatternEnum` (the two stay
value-for-value, asserted by the routing-keys spec —
[ADR-008](../../adr/008-rabbitmq-via-libs-messaging.md)). They are **reserved
surfaces**: published onto `retail_queue` by the cart operations once those land,
with no cross-service consumer bound yet. The cart **command** keys
(`retail.cart.create` / `.get` / the line ops) arrive with the handlers that serve
them, not here.

The in-process domain events (`CartCreatedEvent`, …) and the wire interfaces are
**deliberately separate**: a `DomainEvent` subclass is never serialized across
services ([ADR-011](../../adr/011-notifier-port-and-adapters.md)); the cart use
cases map one to the other after persistence assigns ids.

## Guest carts (a deferred decision)

> **Placeholder — completed by the cart-operations change.**
>
> A cart's `customerId` is nullable so a **guest** (unauthenticated) shopper can
> hold a cart with no customer attached. When that shopper later authenticates,
> their guest cart must be **promoted** to their registered customer — the
> `ICartRepositoryPort.reassignCustomer(cartId, customerId)` seam exists for
> exactly this, but the promotion **use case, its authorization (an ownership
> check, not a permission code — upholding ADR-024's "customer tokens carry no
> permissions claim"), and the gateway claim route are not built yet**. The
> contained, testable walking-skeleton form — an explicit `claim` step rather than
> an implicit merge-on-login — is documented when the cart operations land. This
> section is filled in then.
