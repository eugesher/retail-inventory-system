# ADR-030: Reservation TTL aggregate and the stock-movement ledger

- **Date**: 2026-06-13
- **Status**: Accepted

---

## Context

[ADR-027](027-stocklevel-running-totals-and-stocklocation.md) re-founded inventory
on per-location **`StockLevel` running totals** (`quantityOnHand` /
`quantityAllocated` / `quantityReserved`, with `available = onHand − allocated −
reserved` a pure getter) and shipped a `version` optimistic-concurrency column
that **nothing consumes yet**. It deliberately omitted `reserve` / `allocate` /
`release` mutators — they would have been dead, untested code in a foundation —
and it pointed at a future "`StockMovement`-style audit log" without building one.

Two further facts set up this capability:

- [ADR-028](028-cart-order-payment-and-address-chain.md) rebuilt the retail
  checkout as a mutable `Cart` → immutable `Order` chain and **retired the
  cross-service `inventory.order.confirm` reserve call**. Until that confirm seam
  was deleted (the opening move of this capability), inventory had a vestigial
  deprecation stub and the retail side carried no inventory call at all.
- **The no-oversell invariant is enforced nowhere.** Nothing stops two carts
  racing for the last unit. `available` can already go negative in the domain
  (there is a unit test asserting exactly that); it is a projection, not a guard.

No production data exists, so the capability is built as a clean addition, not a
migration of live rows.

This ADR records the **whole** reservation + stock-movement design in one
document; the code lands incrementally across several sessions (the catalog
Stage-2 precedent of [ADR-029](029-category-materialized-path-and-polymorphic-media.md),
where one ADR decided a multi-session build). The foundation shipped with this
ADR is the `Reservation` aggregate, its table, its repository port, and the three
new error codes; everything else below is **decided here and implemented later**.

## Decision

### 1. The `Reservation` aggregate — a TTL-bounded, cart-scoped hold

A `Reservation` is a hold on stock for one variant at one location, owned by a
cart, that expires on a wall clock. While a reservation is `active`, its
`quantity` is counted into `StockLevel.quantityReserved`, so it is subtracted
from `available`. **This is what lets two carts not race for the last unit before
either checks out** — the unit is held the moment it lands in a cart, which also
powers a "only 1 left!" UX.

It is a **plain framework-free class** (private mutable fields + getters,
invariants in the factory/mutators), consistent with `StockLevel` — **not** an
`AggregateRoot`. The inventory context emits events from its use cases, never
pulls them from the model, so there is no `pullDomainEvents()`.

**Fields.** `id` (an app-generated `CHAR(36)` UUID, minted with
`crypto.randomUUID()` in `create` — the `Cart.create` precedent), `variantId`
(opaque catalog key), `stockLocationId`, `quantity` (positive integer), `cartId`
(opaque retail key), `expiresAt`, `status`, `version`, and load-side
`createdAt` / `updatedAt`.

**Status machine** (`ReservationStatusEnum`, in `domain/` — **not** in
`libs/contracts`; the wire carries the raw string, the lifecycle-enum convention
of [ADR-025](025-catalog-product-and-variant-aggregate.md) §7):

```
                 ┌───────── refresh (active → active, idempotent re-reserve)
                 ▼
   create ──► active ──► committed   (commit, at order placement; terminal)
                 │  ▲
        release  │  │ reactivate
        expire   │  │
                 ▼  │
        released ───┘  (reactivate: released | expired → active)
        expired  ───┘
```

- `refresh(quantity, expiresAt)` — `active → active`: adjust the held quantity and
  push the TTL forward (the idempotent re-reserve path).
- `release()` — `active → released` (terminal).
- `expire()` — `active → expired` (terminal). No caller in this capability beyond
  symmetry (the sweeper is later), but it ships so every state is reachable.
- `commit(now)` — `active → committed`. **Rejects a wall-clock-expired hold**
  (`expiresAt < now` → `RESERVATION_EXPIRED`): the allocate use case refreshes
  first when it decides to honor a stale-but-still-held hold, so commit never
  silently converts an expired hold.
- `reactivate(quantity, expiresAt)` — `released | expired → active`. `committed`
  is **not** reactivatable (a placed order's allocation is never reopened).

Every mutator bumps `version` by one (observable in the unit spec); a
non-positive `quantity` is `RESERVATION_QUANTITY_INVALID`; an illegal transition
is `RESERVATION_INVALID_STATE`. `isExpired(now)` is a strict `<` test (equal
timestamps are **not** expired).

**The all-statuses UNIQUE triple `(cartId, variantId, stockLocationId)` is the
idempotency key.** The constraint spans *every* status, which is precisely why
`reactivate` exists: when a shopper re-adds a previously removed line, the
released row for the triple is **reused**, never duplicated. `create` validates a
strictly-future `expiresAt` with a plain `Error` (a past expiry at create time is
an internal caller bug, not user input); `reconstitute` loads any stored state,
including a past `expiresAt` (a stale `active` row no sweeper has acted on).

**Cross-service FKs stay opaque.** `cart_id`, `variant_id`, and
`stock_location_id` are real foreign keys in the one shared MySQL database
(`ON DELETE RESTRICT`), but the inventory domain never imports the retail `Cart`
or catalog `ProductVariant` — the FK is the only coupling (the
[ADR-026](026-price-append-only-ledger-and-tax-category.md) /
[ADR-027](027-stocklevel-running-totals-and-stocklocation.md) opaque-link
precedent). The entity maps `variant_id` as a plain BIGINT scalar and `cart_id`
as a plain `CHAR(36)` scalar, no `@ManyToOne`.

### 2. The `StockMovement` append-only typed ledger *(implemented next session)*

A `stock_movement` table records **why** a counter changed — the audit trail
ADR-027 deferred. It is an **audit log, not the balance authority**: ADR-027's
running totals remain the source of truth, and row sums are **not** expected to
reconstruct on-hand.

- Six movement **types** with a **fixed sign per type**: positive on
  `receipt` / `return`; negative on `sale` / `allocation` / `release`; either
  non-zero sign on `adjustment`.
- Polymorphic `referenceType` / `referenceId` (`cart` / `order` / `transfer` /
  `return-request`, extensible) with **no FK** (the polymorphic-owner precedent
  of [ADR-029](029-category-materialized-path-and-polymorphic-media.md)'s
  `MediaAsset` and ADR-028's `Address`).
- `actorId` null = a system action.
- **Never UPDATE, never DELETE** — the port exposes append + list only.
- A `release` of a hold records a `release` row, so an expired/cancelled hold
  leaves a trail.

### 3. No-oversell enforcement reuses the existing optimistic write protocol

The guard `available ≥ requested` lives in new `StockLevel` mutators
(`reserve` / `release` / `allocate` / `cancelAllocation`, added when the use
cases land) and runs inside the **existing** bounded optimistic write protocol
that Receive/Adjust already use: a transactional read → mutate → version-checked
persist (`persistStockLevelChange`), with `StockWriteConflictError` retried up to
the shared `MAX_WRITE_ATTEMPTS = 5` budget; exhaustion surfaces a 409
`INVENTORY_STOCK_WRITE_CONFLICT`. The `version` column ADR-027 shipped is exactly
what this consumes — no schema change, no new locking primitive.

A reservation that loses the INSERT race on its UNIQUE triple is translated by
the repository from `ER_DUP_ENTRY` into the same `StockWriteConflictError`, so the
retry re-reads the now-present row (`findByKey`) and converges on `reactivate`
rather than failing.

### 4. Operation policies *(implemented across later sessions)*

- **Reserve** is idempotent-by-absolute-quantity on the triple: a re-reserve sets
  the new quantity, refreshes the TTL, and applies only the *delta* to
  `quantityReserved`. `expiresAt = now + RESERVATION_TTL_MINUTES` (default 15,
  env-tunable; the env var lands with the Reserve use case).
- **Release** flips the row to `released`, returns the counter to `available`, and
  writes a `release` movement. The release `reason` union includes `manual` (an
  ops endpoint) beyond `cart-removed` / `expired` / `order-cancelled`.
- **Allocate** converts an active reservation (refresh-then-commit when
  wall-clock-expired, since the counters are still held — safe until a sweeper
  exists) or falls back to a direct allocation against `available`, writing one
  `allocation` movement per line. The allocate request carries the **lines**
  (`{ variantId, stockLocationId?, quantity }[]`) in addition to
  `cartId` / `orderId`, so the fallback path can allocate without reading retail's
  tables.
- **Cancel Allocation** reverses the counters with a `release` movement.
- The allocate RPC is invoked **inside the retail place transaction, after the
  cart-conversion compare-and-swap**: a rollback means no order and no conversion;
  the rare post-allocate commit failure is compensated by a best-effort
  cancel-allocation call. The two services touch **disjoint tables** of the one
  shared MySQL, so there is no lock interplay between them.

### 5. Event + RPC surfaces *(implemented across later sessions)*

RPCs (gateway → inventory on `inventory_queue`):
`inventory.reservation.{reserve,release,allocate}`,
`inventory.allocation.cancel`, and `inventory.stock-movement.list`. Events emitted
onto `inventory_queue` as **reserved surfaces** (producer-targets-consumer-queue,
[ADR-008](008-rabbitmq-via-libs-messaging.md) /
[ADR-020](020-rabbitmq-as-inter-service-bus.md); the intended consumer is a future
event-store capability): `inventory.stock.{reserved,allocated,released}` and the
high-volume `inventory.stock-movement.recorded`.

### 6. Structured error details *(implemented with the use cases)*

`InventoryDomainException` gains an optional `details` record (e.g.
`{ available }` on an out-of-stock rejection), forwarded through the RPC filter
and the gateway error util, so clients branch on data, not message text.

### 7. Cache key bumps `v2 → v3`

`INVENTORY_STOCK_KEY_VERSION` bumps from `v2` to `v3` when reservations start
moving `quantityReserved`: the cached `VariantStockView` is **semantically
different** (the same field set now reflects holds), and the
[ADR-022](022-cache-keys-tenant-and-schema-version.md) bump rule is about value
semantics, not just shape. (Bumped in the session that ships the Reserve use case,
not this foundation.)

## Alternatives Considered

1. **Allocate only at checkout, no reservation entity (the Vendure stance).**
   Rejected: allocation-at-checkout cannot stop two carts racing for the last unit
   *before* either checks out, and it cannot power a "1 left!" hold. An explicit,
   TTL-bounded reservation is the Saleor/Medusa stance and is what the
   add-to-cart UX needs.
2. **`SELECT … FOR UPDATE` pessimistic locking for no-oversell.** Rejected: the
   optimistic-concurrency `version` column was shipped (ADR-027) for exactly this
   guard, and the bounded-retry protocol already exists and is unit-testable with
   fake repositories. Pessimistic row locks would add lock-contention and
   deadlock surface for no benefit at this scale.
3. **A separate, smaller retry budget for reservations.** Rejected: one write
   protocol, one budget (`MAX_WRITE_ATTEMPTS = 5`). A second budget is a second
   thing to tune and reason about.
4. **Make the movement ledger the balance authority** (sum rows to derive
   on-hand). Rejected for the same reason ADR-027 dropped the `product_stock`
   ledger: read cost grows with history. The ledger is an audit trail; the
   running totals are the truth.
5. **Soft-delete reservations via `deletedAt`.** Rejected: the lifecycle is
   `status` (active/committed/released/expired); `deletedAt` stays inert, as
   everywhere else. Purge-after-retention is a future hardening item.

## Consequences

- A `reservation` table is added: `CHAR(36)` UUID PK; `variant_id` /
  `stock_location_id` / `cart_id` cross-service FKs (`ON DELETE RESTRICT`); a
  `CHECK (quantity > 0)`; the all-statuses **UNIQUE** triple
  `UC_RESERVATION_CART_VARIANT_LOCATION`; and two sweeper indexes
  (`IDX_RESERVATION_EXPIRES_AT`, `IDX_RESERVATION_STATUS_EXPIRES_AT`). The table
  is left at the server-default collation to match the inventory family, with
  `cart_id` overridden to `utf8mb4_unicode_ci` to match the retail `cart` table —
  a string FK requires both sides to share collation.
- `InventoryErrorCodeEnum` gains `RESERVATION_QUANTITY_INVALID` (400),
  `RESERVATION_INVALID_STATE` (409), and `RESERVATION_EXPIRED` (409), all mapped
  by the presentation `InventoryRpcExceptionFilter` total `Record`.
- A new `RESERVATION_REPOSITORY` port (`IReservationRepositoryPort`) is added
  alongside `STOCK_REPOSITORY` — a per-aggregate seam (the
  [ADR-029](029-category-materialized-path-and-polymorphic-media.md)
  one-port-per-aggregate precedent), domain types only, every method scope-aware
  so reservation reads/writes join the `StockLevel` transaction. `findByKey`
  reads any status (the UNIQUE triple); `save` re-reads and translates a lost
  INSERT race to `StockWriteConflictError`.
- **No use case can reach the `Reservation` aggregate yet**, and `expire()` has no
  caller until a sweeper capability — the foundation ships ahead of its
  consumers, exactly as ADR-027 shipped `version` ahead of this guard.
- **No background sweeper exists yet.** A stale `active` hold keeps occupying its
  counter until a manual release endpoint or a later sweeper capability acts.

## References

- [ADR-027](027-stocklevel-running-totals-and-stocklocation.md) — the
  `StockLevel` running totals + unused `version` column this capability builds on;
  the opaque-`variantId`-FK and plain-class (not `AggregateRoot`) conventions.
- [ADR-028](028-cart-order-payment-and-address-chain.md) — the `Cart` whose `id`
  the `cart_id` FK references; the retired cross-service confirm flow; the
  `CHAR(36)` app-generated PK precedent.
- [ADR-022](022-cache-keys-tenant-and-schema-version.md) — the cache-key version
  bump rule (value semantics, not just shape) the `v2 → v3` bump follows.
- [ADR-029](029-category-materialized-path-and-polymorphic-media.md) — the
  one-port-per-aggregate seam and the polymorphic-no-FK reference precedent the
  movement ledger reuses.
- [ADR-019](019-typeorm-and-mysql-for-persistence.md) — the migration workflow
  (`synchronize` off) and the `BaseEntity` ID strategy the string-PK reservation
  diverges from.
- [ADR-017](017-architecture-lint-via-eslint-boundaries.md) — the domain /
  application / infrastructure import boundaries the repository port respects.
