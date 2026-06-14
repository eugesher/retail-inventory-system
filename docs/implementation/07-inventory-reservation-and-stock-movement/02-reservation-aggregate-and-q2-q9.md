# The `Reservation` aggregate, table, and repository

This is the foundation of the inventory-reservation capability: the domain model
for a stock **hold**, the `reservation` table that persists it, the repository
port + adapter, and three new typed error codes. No use case, RPC, event, or wire
contract reaches the aggregate yet — those land in later inventory work. The whole
capability design (including the parts not built here) is recorded in
[ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md).

The model lives at
`apps/inventory-microservice/src/modules/stock/domain/reservation.model.ts`.

## 1. Why an explicit `Reservation` entity

There are two industry stances on when to decrement available stock:

- **Allocate only at checkout** (the Vendure stance). Stock is committed when an
  order is placed. Simple, but it **cannot stop two carts racing for the last
  unit before either checks out**, and it cannot drive a "only 1 left!" hold while
  an item sits in a cart.
- **Reserve on add-to-cart** (the Saleor / Medusa stance). The unit is held the
  moment it lands in a cart, for a bounded time. This is what powers the "1 left!"
  UX and what closes the pre-checkout race.

This project takes the second stance, so it needs a first-class thing to hold:
the `Reservation`. While a reservation is `active`, its `quantity` is counted into
`StockLevel.quantityReserved`, and `available = onHand − allocated − reserved`
(the running-total getter from
[ADR-027](../../adr/027-stocklevel-running-totals-and-stocklocation.md)) drops
accordingly — so a second cart sees the reduced figure immediately.

A `Reservation` is a plain framework-free class with private fields + getters and
invariants in its factory/mutators — the same shape as `StockLevel`, and
deliberately **not** an `AggregateRoot`. The inventory context emits its events
from use cases, never pulls them from the model, so the model has no
`pullDomainEvents()`.

## 2. TTL semantics

A hold is **time-bounded**. `expiresAt` is set to
`now + RESERVATION_TTL_MINUTES` (default 15, env-tunable; the env var itself
arrives with the Reserve use case in a later session). The lifecycle is:

- **Refresh on every cart write.** Changing a line's quantity, or re-adding a
  variant, calls `refresh(quantity, expiresAt)` — it adjusts the held quantity and
  pushes the TTL forward, keeping the hold alive while the shopper is active.
- **Immediate commit on order placement.** Placing an order calls `commit(now)`,
  which walks the hold `active → committed`.
- **A wall-clock-expired hold refuses `commit`.** If `expiresAt < now`, `commit`
  throws `RESERVATION_EXPIRED`. The allocate use case (a later session) refreshes
  the TTL first when it decides to honor a stale-but-still-held hold, so commit
  never silently converts an expired reservation.

`isExpired(now)` is a strict `<` comparison: a hold whose `expiresAt` equals
`now` is **not** yet expired.

> **There is no background sweeper yet.** A stale `active` hold keeps occupying
> its `quantityReserved` counter until a manual release endpoint or a later
> sweeper capability acts. The two indexes the table ships (below) exist for that
> future scan.

## 3. The status machine

Four states, two terminal transitions, and a reuse path:

```
   create ──► active ──► committed         (commit; terminal)
                │ ▲
       release  │ │ reactivate
       expire   │ │
                ▼ │
       released ──┘
       expired  ──┘
```

- `active` — the live hold; the only state that can `refresh` / `release` /
  `expire` / `commit`.
- `committed` — the hold became a firm allocation at order placement. Terminal,
  and **not** reactivatable (a placed order's allocation is never reopened).
- `released` / `expired` — the hold is no longer held, but **the row survives**.

**Why `reactivate` exists.** The `reservation` table carries a UNIQUE constraint
on the triple `(cart_id, variant_id, stock_location_id)` that spans *all* statuses
(§4). So when a shopper removes a line and later re-adds the same variant, there
is already a `released` row for that triple — a fresh `INSERT` would collide.
`reactivate(quantity, expiresAt)` reuses that row, walking it `released | expired
→ active`. The all-statuses UNIQUE triple makes re-adding a removed line a **row
reuse, not an insert**.

Every successful mutator bumps `version` by exactly one (the in-memory
optimistic-concurrency token, observable in the unit spec). Guards: a non-positive
or non-integer `quantity` raises `RESERVATION_QUANTITY_INVALID`; an illegal
transition raises `RESERVATION_INVALID_STATE`; a wall-clock-expired commit raises
`RESERVATION_EXPIRED`. All three are typed `InventoryDomainException` codes mapped
to HTTP by the presentation filter (400 / 409 / 409). `create` rejects a
non-future `expiresAt` with a **plain `Error`** instead — a past expiry at create
time is an internal caller bug (the TTL is always computed forward), not user
input, so it must not surface as a client-facing 4xx. `reconstitute` (the load
path) accepts any stored state, including a past `expiresAt`.

## 4. Schema choices

The `reservation` table
(`migrations/1781309334478-CreateReservationTable.ts`):

- **`id CHAR(36)` UUID PK**, generated in-app by `Reservation.create` with
  `crypto.randomUUID()` — the `cart` / `address` precedent
  ([ADR-028](../../adr/028-cart-order-payment-and-address-chain.md)), diverging
  from the project's auto-increment integer PK. The entity overrides
  `BaseEntity`'s numeric `id` the same way `CartEntity` / `AddressEntity` /
  `StockLocationEntity` do.
- **The UNIQUE triple as the idempotency anchor.**
  `UC_RESERVATION_CART_VARIANT_LOCATION (cart_id, variant_id, stock_location_id)`
  spans every status, which is the structural reason `reactivate` exists (§3) and
  the reason a lost INSERT race converges on reuse rather than a duplicate (below).
- **Two sweeper indexes.** `IDX_RESERVATION_EXPIRES_AT (expires_at)` and
  `IDX_RESERVATION_STATUS_EXPIRES_AT (status, expires_at)` serve the future
  sweeper's "find stale active holds" scan (the composite one narrows by status
  first).
- **Cross-service FKs in the one shared database.** `variant_id →
  product_variant(id)`, `stock_location_id → stock_location(id)`, and `cart_id →
  cart(id)`, all `ON DELETE RESTRICT` — a referenced variant / location / cart
  cannot be deleted out from under a live hold. The columns stay **semantically
  opaque** to the inventory domain: the entity maps `variant_id` as a plain BIGINT
  scalar and `cart_id` as a plain `CHAR(36)` scalar with no `@ManyToOne`, and the
  domain never imports the catalog or retail aggregates (the opaque-link
  convention of ADR-026 / ADR-027).
- **A `CHECK (quantity > 0)`** backs the positive-quantity invariant at the DB
  (MySQL 8.4 enforces `CHECK`, as `stock_level` / `cart_line` rely on).
- **`version`** is a TypeORM `@VersionColumn`; the no-oversell guard it ultimately
  feeds runs inside the existing bounded optimistic write protocol when the
  Reserve / Allocate use cases land (ADR-030 §3).
- **`deleted_at` stays inert.** A hold's lifecycle is its `status`, never a
  soft-delete timestamp — the catalog / pricing / stock convention.

> **Collation note.** A string foreign key requires both columns to share charset
> *and* collation. This table FKs onto two collation families: `stock_location` /
> `product_variant` sit at the MySQL 8.4 server default (`utf8mb4_0900_ai_ci`),
> while `cart` is `utf8mb4_unicode_ci` (it matches the auth `customer` table). One
> table-level `COLLATE` can't satisfy both, so the table is left at the server
> default (the inventory family) and only `cart_id` is overridden per-column to
> `utf8mb4_unicode_ci`.

### The repository seam

`IReservationRepositoryPort` (`RESERVATION_REPOSITORY`) is a **separate
per-aggregate port** alongside `STOCK_REPOSITORY` — the one-port-per-aggregate
precedent of [ADR-029](../../adr/029-category-materialized-path-and-polymorphic-media.md).
It returns domain types only (no `typeorm` leak — ADR-017), and **every method is
transaction-scope-aware** so reservation reads/writes join the same unit of work
as the `StockLevel` counter change:

```ts
findById(id, scope?)
findByKey(cartId, variantId, stockLocationId, scope?)   // any status — the UNIQUE triple
listActiveByCart(cartId, scope?)
listActiveByCartAndVariant(cartId, variantId, scope?)
save(reservation, scope?)                               // insert-or-update by id; re-read
```

`ReservationTypeormRepository` is the single `@InjectRepository(ReservationEntity)`
site. Its `save` re-reads the row so the committed `version` and DB timestamps come
back concrete, and it **translates a lost INSERT race on the UNIQUE triple
(`ER_DUP_ENTRY`) into the existing `StockWriteConflictError`** — so the shared
bounded-retry write protocol (added with the Reserve use case) re-reads the
now-present row via `findByKey` and reactivates it, rather than failing. The
`@VersionColumn` value is owned by TypeORM and intentionally not written by the
mapper, so the managed optimistic-lock token is never raced by a manual value (the
`StockLevel` / `Cart` mapper convention).

## Tests

`domain/spec/reservation.model.spec.ts` covers the happy-path `create` (active,
version 0, UUID id, fields set), the quantity guard on `create` / `refresh` /
`reactivate` (asserted via `err.code`, never the message), every status
transition from `active` and the rejection of each from a non-active state, the
`reactivate` reuse from `released` / `expired` and its refusal from `active` /
`committed`, the `commit` TTL guard and the `isExpired` strict-`<` boundary, that
every successful mutator bumps `version` by exactly one, and that `reconstitute`
accepts a past `expiresAt`. There is no e2e in this foundation — no RPC or gateway
route reaches the aggregate yet.

See
[01-legacy-confirm-seam-removed.md](01-legacy-confirm-seam-removed.md) for the
cleanup that preceded this, and
[ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)
for the full capability design (the `StockMovement` ledger, the no-oversell write
protocol, the operation policies, and the event/RPC surfaces decided there and
implemented in later sessions).
