# Cart and CartLine — the mutable side of the rebuilt checkout

This document describes the retail microservice's **mutable shopping cart** end to
end: the `Cart` aggregate root, its `CartLine` children, their two tables, the
repository contract, the cart wire contracts, the six **cart operations**
(Create / Get / Add-to-Cart / Change-Quantity / Remove / Claim) with their RPC
handlers and reserved-surface `retail.cart.*` events, the **gateway HTTP surface**
that fronts them under `/api/cart`, and the **guest-cart** path — a guest-tier
token plus an explicit `claim` promotion. It is the working cart: a shopper
(registered or guest) opens a cart, adds priced lines, edits them, and a guest
later promotes their cart into a registered account.

The decisions this implements are recorded in
[ADR-028](../../adr/028-cart-order-payment-and-address-chain.md) (the cart
aggregate, the guest-cart model, and the bearer-plus-owner-check authorization)
and [ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md) (why
customer authorization is an owner-check, not a permission code).

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

Two families of routing key live in `ROUTING_KEYS` and the mirrored
`MicroserviceMessagePatternEnum` (kept value-for-value, asserted by the
routing-keys spec — [ADR-008](../../adr/008-rabbitmq-via-libs-messaging.md)):

- the four **event** keys (`retail.cart.created`, `retail.cart.line-added`,
  `retail.cart.line-removed`, `retail.cart.line-quantity-changed`) — past-tense
  notifications, the **reserved surfaces** emitted onto `retail_queue` (no consumer
  bound yet); and
- the six **command** keys (`retail.cart.create` / `.get` / `.add-line` /
  `.change-line-quantity` / `.remove-line` / `.claim`) — imperative RPCs the
  gateway calls and the retail cart controller serves.

The in-process domain events (`CartCreatedEvent`, …) and the wire interfaces are
**deliberately separate**: a `DomainEvent` subclass is never serialized across
services ([ADR-011](../../adr/011-notifier-port-and-adapters.md)); the cart use
cases map one to the other after persistence assigns ids.

## The cart operations

Six use cases at `apps/retail-microservice/src/modules/cart/application/use-cases/`
implement the cart, each returning a `CartView` and logging the `correlationId`
inline (microservice handlers cannot use request-scoped log assignment —
[ADR-011](../../adr/011-notifier-port-and-adapters.md)). They are reached by the
retail `cart.controller.ts`'s six `@MessagePattern` handlers on `retail_queue`,
which the gateway calls (next section).

| Operation | RPC key | What it does |
| --- | --- | --- |
| **Create Cart** | `retail.cart.create` | Opens a new `active` cart for the caller; defaults `currency`→`USD`; emits `retail.cart.created`. |
| **Get Cart** | `retail.cart.get` | Returns the cart view (owner-checked); `404` if missing. |
| **Add to Cart** | `retail.cart.add-line` | Resolves the variant's price, snapshots it onto a new/incremented line; emits `retail.cart.line-added`. |
| **Change Quantity** | `retail.cart.change-line-quantity` | Sets a line's quantity (`0` rejected); emits `retail.cart.line-quantity-changed`. |
| **Remove from Cart** | `retail.cart.remove-line` | Drops a line; emits `retail.cart.line-removed`. |
| **Claim Cart** | `retail.cart.claim` | Promotes a guest cart to a registered customer (see [Guest carts](#guest-carts-and-the-claim-promotion-q1q7)). |

### Add-to-Cart snapshots the applicable price

Add-to-Cart is the only operation that reaches outside the cart context. A cart
line must carry a **real price snapshot** taken at add-time, so the use case asks
the catalog microservice for the variant's applicable price before mutating:

1. It calls the catalog `catalog.price.select` RPC through a dedicated port,
   `ICartCatalogGatewayPort` (`CART_CATALOG_GATEWAY`), backed by
   `CartCatalogRabbitmqAdapter` — one of the cart module's two `ClientProxy`
   holders. The query uses the **cart's own currency**, so the snapshot is always
   in the currency the cart was opened in.
2. `catalog.price.select` resolves to a single `PriceView` (priority then recency
   — the resolution policy lives in the catalog, not the cart) **or `null`** when
   the variant is unknown or has no in-effect price.
3. A `null` is a **rejection** (`CART_VARIANT_NOT_PRICED`, mapped to `409`): the
   variant cannot be added in its current pricing state, and the cart never
   persists a zero-price line. Otherwise the use case calls
   `cart.addLine({ …, unitPriceSnapshotMinor: price.amountMinor, currencySnapshot:
   cart.currency })`, which appends a new line or increments the existing one for
   that variant (preserving the original snapshot).

Keeping the price source behind a port (not a raw `ClientProxy` in the use case)
is the gateway port-and-adapter rule applied inside a microservice
([ADR-009](../../adr/009-port-adapter-at-the-gateway.md) /
[ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)): the use case is
unit-tested against a price double, with no live RabbitMQ.

### The reserved `retail.cart.*` events

Each mutating operation maps its in-process `DomainEvent` to the matching wire
event and emits it through `ICartEventsPublisherPort` (`CART_EVENTS_PUBLISHER`,
backed by `CartRabbitmqPublisher`, the module's other `ClientProxy` holder) onto
**`retail_queue` — the producer's own queue**. No `@EventPattern` consumer is
bound to these yet; they are **reserved surfaces** (the same pattern the
`inventory.stock.{received,adjusted}` events follow), held by the broker for a
future consumer such as cart-recovery or analytics. A publish failure is
**best-effort**: the use case warn-logs and swallows it, because the cart write has
already committed ([ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)).

## Authorization — bearer plus owner-check (Q3)

Every cart route is **bearer-protected by default** (the gateway's global
`JwtAuthGuard`). A customer-tier token — registered *or* guest — passes the guard;
with no `@RequiresPermission`/`@Roles` on the route, the permission and role guards
allow it, because **customers carry no permissions claim**
([ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)).

Authorization is therefore **not a permission code** — it is an **owner-check**:
the caller may only touch *their own* cart. Adding a
`@RequiresPermission('customer:own-orders:read')` gate would be self-defeating —
it would reject the very customers it targets, since their tokens carry no
permissions. Instead:

- The **gateway** binds the cart-operation identity to the **authenticated
  subject**: every controller folds `@CurrentUser().id` into the command's
  `customerId`. A customer can never act as another customer, because the gateway
  takes the identity only from the verified JWT — never from the request body or a
  path param.
- The **retail use case enforces** `cart.customerId === customerId` and rejects a
  mismatch with `CART_ACCESS_FORBIDDEN` (mapped to `403`). This is the **single
  enforcement point**: it has the cart aggregate already loaded, so there is no
  redundant "load then write" round-trip (which would also be a time-of-check /
  time-of-use race). The retail service never blindly trusts the edge — it
  re-asserts ownership itself.

A non-owner thus gets `403`; an unauthenticated caller gets `401` (from the global
guard, before any RPC). The end-to-end test exercises both: a second customer
cannot `GET` the first's cart, and an anonymous create/get is rejected.

Domain rejections cross the wire as `{ statusCode, message, code }` via the retail
`CartRpcExceptionFilter` (a total `Record<CartErrorCodeEnum, HttpStatus>`,
exhaustive at compile time — the catalog/inventory filter pattern), which the
gateway's `throwRpcError` resolves back into the matching `HttpException`
(`404`/`403`/`409`/`400`).

## The gateway `modules/cart/`

The gateway fronts the six RPCs over HTTP at `/api/cart`
(`apps/api-gateway/src/modules/cart/`). It is a per-module hexagonal slice with
**no `domain/`** of its own ([ADR-009](../../adr/009-port-adapter-at-the-gateway.md)):
`CartRabbitmqAdapter` (the sole `ClientProxy` holder) backs `CART_GATEWAY_PORT`,
and six thin use cases plus the controller depend on the port symbol only.

| Method | Path | Body | Use case |
| --- | --- | --- | --- |
| `POST` | `/api/cart` | `{ currency? }` | Create Cart (`customerId = @CurrentUser().id`) |
| `GET` | `/api/cart/:cartId` | — | Get Cart |
| `POST` | `/api/cart/:cartId/lines` | `{ variantId, quantity }` | Add to Cart |
| `PATCH` | `/api/cart/:cartId/lines/:lineId` | `{ quantity }` | Change Quantity |
| `DELETE` | `/api/cart/:cartId/lines/:lineId` | — | Remove from Cart |
| `POST` | `/api/cart/:cartId/claim` | `{ fromCustomerId }` | Claim Cart |

`cartId` is the `CHAR(36)` UUID (a string param); `lineId` is the BIGINT
`cart_line.id`. Request DTOs (`class-validator`) are the edge guard — `variantId`
and `quantity` positive integers, `fromCustomerId` a UUID, `currency` an optional
3-letter code — so a malformed request fails fast with a `400` before an RPC is
dispatched. The cart domain has the final say on every invariant.

## Guest carts and the `claim` promotion (Q1/Q7)

A storefront must let a shopper fill a cart **before** they register or log in. The
conventional framing for this is a cookie-backed "session cart". This system's auth
primitive is the **bearer token**, not a cookie, so the guest cart is modelled with
a **guest-tier token** rather than a session cookie — a deliberate, documented
deviation from the cookie approach.

### Every cart has a real `Customer` row — guests included (Q7)

A guest is **not** a null-customer cart. `POST /auth/customer/guest-session`
(`@Public()`, the single guest-bootstrap exception to the bearer-everywhere rule)
mints a real `Customer` row with `status='guest'` and a `null` `password_hash`,
then issues a customer-tier access+refresh pair (claims `roles:[] /
permissions:[]`, `sub = guestCustomerId`). The response is the token pair **plus
the `customerId`**. So every cart — guest or registered — has a Customer row
behind it (Q7); `cart.customerId` is never null in practice on this path, even
though the column stays nullable for the FK-tombstone reason.

Modelling a guest as a real, **logged-in-able** row (rather than a null owner) is
what lets the guest hit the *same* bearer-protected cart routes as a registered
customer — Create / Add / Change / Remove all work unchanged with a guest token.
For the token to validate, a guest is made **authenticatable**: the customer
repository's subject check is `existsAuthenticatableById` — `status IN
('active','guest')` — and `ValidateJwtSubjectUseCase` points at it. Only
`suspended`/`deleted` are barred; a guest is a first-class authenticated subject.

A synthetic per-guest email (`guest-<uuid>@guest.local`) satisfies the `Customer`
email invariant and the table's `UNIQUE(email)` without ever being a deliverable
address (the `.local` TLD signals that).

### Promotion is an explicit `claim`, with a `fromCustomerId` proof

When a guest later registers (or logs in to an existing account), their guest cart
is promoted to the registered customer by an **explicit `claim`** —
`POST /api/cart/:cartId/claim`, called with the **registered** customer's token:

1. The body carries `{ fromCustomerId }` — the **guest id** the client received
   from the guest-session response. Knowing it is the **ownership proof**: only the
   client that ran the guest session holds that id.
2. The gateway folds `@CurrentUser().id` (the registered customer) into
   `newCustomerId` — the new owner is never taken from the body.
3. The retail `ClaimCartUseCase` re-points the cart **only if** `cart.customerId
   === fromCustomerId`, via `ICartRepositoryPort.reassignCustomer(cartId,
   newCustomerId)`. A wrong `fromCustomerId` is a `403`; a missing cart a `404`.

After the claim the cart belongs to the registered customer (lines preserved), the
registered token resolves it, and the **guest token can no longer read it** — a
`403`, because ownership has moved. The end-to-end test walks exactly this path.

### Why explicit `claim`, and what comes later

The explicit `claim` is the **contained, testable** walking-skeleton form of
promotion: one deterministic step, owner-proven, with a clear authorization story.
**Auto-promotion on login** — the guest cart silently merging into the customer's
own cart at login, with no explicit call — is a richer behaviour (it must decide
how to *merge* two carts, dedupe lines, and reconcile prices). It is a later
refinement; the explicit `claim` is what ships here.
