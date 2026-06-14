# Movements audit read + manual reservation release over HTTP

This change fronts two pieces of inventory state for **operators** over HTTP:

- a **paginated, filterable, newest-first audit read** of one variant's
  `stock_movement` ledger —
  `GET /api/inventory/variants/:variantId/movements` — backed by a new RPC
  `inventory.stock-movement.list` → `ListStockMovementsUseCase`; and
- a **manual reservation release** —
  `POST /api/inventory/reservations/:reservationId/release` — riding the existing
  `inventory.reservation.release` RPC with the `reservationId` selector, a fixed
  `reason: 'manual'`, and the staff actor folded in for ledger attribution.

Both routes are gateway-only wiring over RPCs the inventory microservice already
serves (the append-only ledger and its `listByVariant` read seam shipped with the
ledger itself; the release use case shipped with the reservation surface). No
schema change, no migration, no new permission code.

Related decisions:
[ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)
(the ledger is the audit trail — §2 — and a TTL-bounded hold's only operator-
reachable freeing tool until a sweeper exists is a manual release with a `manual`
reason — §4/§5),
[ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md) (the
`inventory:read` / `inventory:adjust` gates — both staff-only by construction),
[ADR-009](../../adr/009-port-adapter-at-the-gateway.md) (the gateway port/adapter
split — `ClientProxy` only in the adapter),
[ADR-008](../../adr/008-rabbitmq-via-libs-messaging.md) (the dotted routing key
mirrored across `libs/messaging` and `libs/contracts`, asserted in lock-step).
The ledger record itself is documented in
[03-stock-movement-typed-ledger.md](03-stock-movement-typed-ledger.md); its
writers in [06-allocate-on-place.md](06-allocate-on-place.md),
[08-receive-adjust-now-write-movements.md](08-receive-adjust-now-write-movements.md),
and [09-transfer-stock-two-movements.md](09-transfer-stock-two-movements.md); the
release use case in
[04-no-oversell-invariant-and-occ.md](04-no-oversell-invariant-and-occ.md).

## The audit read

### Shape

`GET /api/inventory/variants/:variantId/movements` returns an
`IPage<StockMovementView>`:

```jsonc
{
  "items": [
    {
      "id": 42,
      "variantId": 1,
      "stockLocationId": "default-warehouse",
      "type": "adjustment",
      "quantity": -3,          // signed: + receipt/return, − sale/allocation/release, ± adjustment
      "reasonCode": "damaged", // the operator reason on an adjustment, or a release reason
      "referenceType": "order", // polymorphic, FK-less: cart / order / transfer / return-request
      "referenceId": "500",
      "actorId": "staff-1",    // null = a system action
      "occurredAt": "2026-06-10T08:30:00.000Z"
    }
  ],
  "total": 137,
  "page": 1,
  "size": 20
}
```

`page` / `size` echo the applied paging; `total` is the full match count so a
client can compute the page count.

### Paging, filters, ordering

- **Paging** is 1-based. The gateway DTO (`MovementsQueryDto`) defaults
  `?page`→1 and `?pageSize`→20 at the edge and caps `?pageSize` at **100**
  (`@Min(1) @Max(100)`). `pageSize` maps onto the RPC payload's `size` — the
  `?page/?pageSize` precedent of the orders list. (The page-size ceiling is
  enforced here in the DTO; unlike the orders read, the inventory use case does
  not re-cap.)
- **Filters**: `?type` narrows to one `StockMovementTypeEnum`
  (`receipt` / `adjustment` / `allocation` / `sale` / `release` / `return`);
  `?from` / `?to` are ISO-8601 instants that bound `occurredAt` **inclusively**
  (`@IsISO8601()`). The use case parses the strings into `Date`s and treats an
  unparseable value as **absent** — the DTO is the validation gate, so the read
  path never returns a 4xx for a malformed bound, it simply drops it.
- **Ordering** is newest-first (`occurred_at DESC, id DESC`), owned by the
  repository and served by the descending
  `IDX_STOCK_MOVEMENT_VARIANT_OCCURRED (variant_id, occurred_at DESC)` index. The
  `id DESC` tiebreaker makes the order total when two rows share an instant.

### Zero-answer convention (no existence probe)

An unknown variant — or a variant that simply has no movements — is a **`200`
empty page** (`items: []`, `total: 0`), never a `404`. This mirrors the
per-variant availability read, where an unknown variant is a zero-availability
answer rather than a not-found. There is deliberately no existence probe: the
ledger read is per-variant and an empty timeline is a meaningful answer.

### Why it is uncached

Unlike the per-variant availability read (cache-aside, with post-commit
invalidation on every write), the audit read takes **no cache**. The ledger grows
monotonically and an audit query is low-frequency, operator-driven, and expects to
see the *latest* rows. Caching it would add an invalidation hop to **every**
counter-changing operation — all of which append a movement — for no hit-rate
benefit, and would risk serving a stale timeline to the very person checking what
just happened. So `ListStockMovementsUseCase` injects no `STOCK_CACHE`.

## The manual reservation release

### When an operator reaches for it

A reservation is a TTL-bounded hold on stock for a cart. The reserve / release /
allocate flows are driven automatically by cart and order traffic, but two gaps
leave a hold occupying its counter longer than intended:

- a **best-effort release failure** on Remove-from-Cart (the release is fired
  after the cart save, try/warn/swallow — a failure over-holds until something
  reclaims it), and
- a **post-allocate commit failure** on Place Order, whose compensating
  cancel-allocation is also best-effort.

In both cases the hold is never *lost* — only delayed in returning to
`available`. Until a TTL-sweeper capability lands, **this endpoint is the only
operator-reachable tool to free such a hold.** A stale `active` hold otherwise
keeps subtracting from `available` even past its `expiresAt` (nothing reclaims an
expired hold automatically yet).

### `manual` reason + actor attribution

The route targets exactly **one** hold by id (the `reservationId` selector of the
release RPC) and folds two things into the payload that an automated release would
not:

- `reason: 'manual'` — a member of the release `reason` union
  (`cart-removed` | `expired` | `order-cancelled` | `manual`). It is carried onto
  the `release` `stock_movement` row's `reason_code`, so the ledger records
  *that a human freed this hold*, distinct from a cart-removal or an
  order-cancellation.
- `actorId` = the staff caller's id (`@CurrentUser().id`). The movement's
  `actor_id` is therefore the operator, not `null` (which means "system"). The
  release is auditable end-to-end: the same audit read above surfaces the
  `manual`-reason, operator-attributed `release` row immediately afterward.

### Status outcomes

A by-id release is precise, never a silent no-op:

- unknown id → `404 INVENTORY_RESERVATION_NOT_FOUND`;
- an already-`released` or `committed` row → `409
  INVENTORY_RESERVATION_INVALID_STATE`;
- success → `200` with `{ released: [ ReservationView ] }` (exactly one element).

Both error codes are surfaced from the inventory domain via its RPC exception
filter and mapped to HTTP by the gateway's `throwRpcError` (which forwards the
typed `code` and any structured `details`).

## Permission mapping — no new code minted

Per [ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md), a
permission code is a precise gate and a new one is minted only when an existing
code does not fit. Neither route needs a new code:

- the **audit read** is operational data about a variant's history — the same
  class of staff-only operational read as the stock-location list — so it reuses
  **`inventory:read`**;
- the **manual release** mutates inventory state (a hold's lifecycle + a ledger
  append), an operator action over the holds, so it reuses **`inventory:adjust`**
  (the same code that gates Receive and Adjust).

Both codes are staff-only by construction — customer tokens carry no `permissions`
claim — so both routes are staff-only without any extra guard. No new
`PermissionCodeEnum` member was added.

## Known gap — no reservation read surface

There is intentionally **no HTTP endpoint that returns a reservation id**. A
reservation list/read surface is not part of this capability. An operator obtains
the `reservationId` the release route needs from one of:

- the **reserve-path logs** (`reservationId` is logged when a cart line is
  reserved on add-to-cart / change-quantity),
- the **`inventory.stock.reserved` event** payload (on `inventory_queue`), or
- the **`reservation` table** directly.

This is acceptable for an ops/debug endpoint; the `.http` file documents the
sourcing explicitly.

## Try it

The Kulala flows live in [`http/inventory.http`](../../../http/inventory.http):

- `listVariantMovements` — `GET .../variants/1/movements?page=1&pageSize=20`
  (bearer, `inventory:read`); run the receive/adjust/transfer requests above it
  first to populate the ledger.
- `listVariantMovementsFiltered` — the same read narrowed by
  `?type=receipt&from=...&to=...`.
- `releaseReservation` — `POST .../reservations/{{reservationId}}/release`
  (bearer, `inventory:adjust`), with an `@reservationId` variable and a comment
  on how to source a real hold id.
- `releaseReservationNotFound` — the `404` demo with a random UUID.
