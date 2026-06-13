# Retail wiring: reserve on add/change, release on remove, allocate on place

This note explains how the **retail** microservice was wired onto the inventory
**reservation surface** so the cart and order flows hold real stock. Until now the
reservation RPCs (`inventory.reservation.reserve` / `.release` / `.allocate` +
`inventory.allocation.cancel`) were live inventory-side but had no caller — the
cart could grow without bound and an order could be placed for stock that did not
exist. This change closes that **oversell hole** without changing anything visible
to a successful HTTP caller: Add-to-Cart and Change-Quantity now reserve, Remove
releases, and Place allocates atomically with the cart conversion.

The note assumes only the repository as it stands — no planning materials.

Related decisions:
[ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)
(the reservation hold lifecycle, the reserve/release/allocate/cancel policies, the
allocate-inside-the-place-transaction decision, the structured-error `details`
forwarding),
[ADR-028](../../adr/028-cart-order-payment-and-address-chain.md) (the mutable
`Cart` + immutable `Order` split, the module isolation, the
`<MODULE>_<DOWNSTREAM>_GATEWAY` port-naming convention),
[ADR-009](../../adr/009-port-adapter-at-the-gateway.md) /
[ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md) (`ClientProxy` only inside
`infrastructure/messaging/*-rabbitmq.adapter.ts`; `firstValueFrom`).
The inventory-side operations the retail wiring calls are documented in
[04-no-oversell-invariant-and-occ.md](04-no-oversell-invariant-and-occ.md) (reserve
/ release) and [06-allocate-on-place.md](06-allocate-on-place.md) (allocate /
cancel).

## 1. The seam — two module-prefixed ports

The retail checkout is two isolated modules (ADR-028): a mutable `Cart`
(`modules/cart/`) and an immutable `Order` (`modules/orders/`). Neither imports the
other; each declares its own outbound ports. So the single conceptual "retail →
inventory reservation" seam lands as **two** module-prefixed ports, each following
the established `<MODULE>_<DOWNSTREAM>_GATEWAY` convention (the
`CART_CATALOG_GATEWAY` / `ORDER_CATALOG_GATEWAY` precedent):

| Port | Module | Methods | Backed by |
|---|---|---|---|
| `CART_INVENTORY_GATEWAY` | `modules/cart/` | `reserveStock(payload) → ReservationView`, `releaseStock(payload) → IReservationReleaseResult` | `CartInventoryRabbitmqAdapter` |
| `ORDER_INVENTORY_GATEWAY` | `modules/orders/` | `allocateStock(payload) → IAllocationResult`, `cancelAllocation(payload) → void` | `OrderInventoryRabbitmqAdapter` |

Each adapter injects the `INVENTORY_MICROSERVICE` client and `send`s on the
`ROUTING_KEYS.INVENTORY_RESERVATION_*` / `INVENTORY_ALLOCATION_CANCEL` keys, so the
RPCs land on `inventory_queue`. The use cases depend only on the port symbol — the
`ClientProxy` lives **only** in the two adapters (ADR-009 / ADR-020), which the
architecture lint enforces.

A single `INVENTORY_RESERVATION_GATEWAY` was rejected: it would force a shared
provider across the two isolated modules, re-coupling what ADR-028 deliberately
split.

### The error-passthrough rule (why `RpcException(err)`)

A reserve/allocate rejection must reach the HTTP caller with its typed `code` and
structured `details` intact — e.g. an out-of-stock add is a
`409 INVENTORY_OUT_OF_STOCK` carrying `details: { available: n }`, which the
storefront uses to show "only n left". The error travels through **three** services:

```
inventory RPC filter            → { statusCode, message, code, details }   (over RMQ)
retail adapter.firstValueFrom   → rejects with that object
retail adapter                  → rethrows `new RpcException(err)`
retail @MessagePattern handler  → Nest serializes RpcException.getError() back     (over RMQ)
gateway adapter.firstValueFrom  → rejects with that object
gateway use case                → throwRpcError(err) → HTTP 409 + code + details
```

The adapter **must** wrap the rejection in `new RpcException(err)`. An uncaught
plain-object rejection is re-wrapped lossily by Nest's transport layer (the typed
`code` and `details` would be dropped). The retail RPC exception filters are
`@Catch(CartDomainException)` / `@Catch(OrderDomainException)` only, so an
`RpcException` carrying the inventory object passes straight through them and is
serialized back to the gateway **verbatim**. This is the contract the gateway's
`throwRpcError` relies on (see §4).

## 2. Ordering decisions — the deliberate asymmetry

The cart writes reserve **before** the cart is persisted, but release **after** —
and that asymmetry is the whole point.

### Add to Cart — reserve before save (absolute quantity)

`AddToCartUseCase` snapshots the price (rejecting an unpriced variant first), then
computes the line's **absolute** target — `(existing line for variantId)?.quantity
?? 0) + payload.quantity`, because `Cart.addLine` increments an existing line —
and calls `reserveStock({ variantId, quantity: targetQty, cartId, correlationId })`
**before** `cart.addLine` / `repository.save`. No `stockLocationId` is sent
(single-location routing; inventory defaults it to the default warehouse).

The reserve RPC is idempotent-by-absolute-quantity: a repeat add re-sets the hold
to the new total and refreshes the TTL, applying only the counter delta. If the
target exceeds available stock, the reserve rejects with `INVENTORY_OUT_OF_STOCK`
and **the cart is never mutated**.

Reserve-before-save is deliberate. Consider the two failure windows:

- **reserved, then save fails** → stock is over-held until the line's release or
  the hold's TTL lapse. Self-healing, no oversell.
- **saved, then reserve fails** (the rejected ordering) → the cart shows a line for
  stock that was never held, reopening the oversell hole the capability exists to
  close.

The first is strictly safer, so reserve goes first.

### Change Quantity — re-reserve the absolute new quantity

`ChangeCartLineQuantityUseCase` resolves the line (the existing
`CART_LINE_NOT_FOUND` guard), then reserves the **absolute new quantity** before
mutating + saving. The reserve's idempotent-absolute semantics adjust the counter
delta and refresh the TTL in **either** direction — raising the quantity past
available stock rejects with `INVENTORY_OUT_OF_STOCK`; lowering it returns units.
(A `0` is rejected at the gateway DTO's `@Min(1)`; on the direct-RMQ path the
reserve RPC's own positive-int guard rejects it before the domain backstop.)

### Remove from Cart — release after save (best-effort)

`RemoveFromCartUseCase` captures the line's `variantId` **before** `cart.removeLine`
drops it, then — **after a successful save** — calls
`releaseStock({ cartId, variantId, reason: 'cart-removed', correlationId })` as a
**best-effort** try/warn/swallow (the event-emit style). The cart write is the
primary outcome: a failed release merely over-holds stock until the manual release
endpoint or a later TTL sweep frees it, and must never fail the remove. (A failed
line lookup throws `CART_LINE_NOT_FOUND` before the release is reached, so a missing
line is never released.)

### Claim Cart — untouched

`ClaimCartUseCase` makes **no** inventory call. Reservations key on `cartId`, which
a claim re-points the *owner* of but never changes, so a guest cart's holds survive
promotion to a registered customer untouched.

## 3. Allocate on place — inside the conversion transaction

`PlaceOrderUseCase` already ran one transaction `{ save order + lines → save
addresses → attachAddresses → markConverted CAS }`. Allocate is inserted as the
**final step inside that transaction, after the `markConverted` compare-and-swap
succeeds**:

```ts
allocateStock({
  cartId,
  orderId: persisted.id!,
  lines: lines.map(l => ({ variantId: l.variantId, quantity: l.quantity })),
  correlationId,
})
```

The lines ride the payload so inventory's direct-allocation fallback never has to
read retail's cart tables (ADR-030).

- **Allocate-after-CAS** means a concurrent double-place loser throws on the CAS
  *before* ever allocating — there is no double allocation to unwind.
- **An allocate rejection rolls the whole place back.** If a hold expired-and-was-
  released and the direct-allocation fallback finds insufficient stock, allocate
  rejects with `INVENTORY_OUT_OF_STOCK`; the rejection propagates out of the
  transaction callback, so **no order row is written, the cart stays `active`** and
  fixable, and the typed `409 + details.available` reach the caller.
- **Allocate precedes payment authorization** (which stays outside the transaction,
  after it), so money is never authorized for stock that could not be allocated.

### Holding the DB transaction across the RPC

The allocate RPC is awaited *inside* the place transaction. That is accepted and
bounded: the inventory handler runs its **own** short transaction on **disjoint
tables** (`stock_level` / `reservation` / `stock_movement`) of the one shared MySQL
— no lock interplay with the retail `order` / `cart` rows — and the RPC is an
in-cluster round-trip (ADR-030 records the trade-off).

### The compensation path

Once allocate resolves, the allocation has committed in inventory's own
transaction. Only the retail place transaction's **commit itself** can still fail
afterward (rare). The use case tracks `allocated = true` + the `orderId` across the
transaction boundary; on a post-allocate failure it best-effort fires
`cancelAllocation({ orderId, lines, reason: 'place-rollback', correlationId })`
**outside** the failed transaction (its own RPC into inventory's own transaction),
warn-logs any compensation failure, and **rethrows the original error**. The
`reason` is a free-string movement `reason_code` (defaulting `order-cancelled`); the
explicit `'place-rollback'` keeps the ledger honest about *why* the allocation was
unwound. An allocate *rejection* leaves `allocated = false`, so nothing is
compensated there — inventory already rolled its own attempt back.

Repeat-place is cart-state-driven (ADR-028): a `converted` cart short-circuits to
the existing order and **never allocates again**.

## 4. Error surface — `details` end-to-end

The gateway's `throwRpcError` util learned to forward a structured, object-valued
`details` alongside the typed `code`:

```
{ statusCode, message, code }                      // unchanged when no details
{ statusCode, message, code, details: { available } }  // when the upstream carried details
```

Combined with the `RpcException(err)` passthrough (§1) and the inventory RPC
filter's existing `details` emission, an out-of-stock Add-to-Cart now surfaces to
the storefront as a single self-describing body:

```
HTTP 409
{ "statusCode": 409, "message": "...", "code": "INVENTORY_OUT_OF_STOCK",
  "details": { "available": 3 } }
```

A non-RPC error (no `code`, or a NaN `statusCode`) still collapses to the bare 500,
and an upstream rejection with a `code` but no `details` keeps the
`{ statusCode, message, code }` shape — the change is purely additive.

## 5. Testing

Unit specs exercise each wiring point with in-memory fakes
(`InMemoryCartInventoryGateway` / `FakeOrderInventoryGateway`, both recording calls
and supporting a programmable wire-shaped rejection):

- **Add to Cart** — reserve called with the absolute target (fresh line = payload
  qty; increment = existing + payload), **before** `repository.save`; an
  `INVENTORY_OUT_OF_STOCK` rejection propagates and the cart is never saved; the
  price gate fires before the reserve.
- **Change Quantity** — re-reserve the absolute new quantity (up and down); a
  rejection → no save.
- **Remove from Cart** — release called *after* save with
  `(cartId, variantId, 'cart-removed')`; a release failure is swallowed (warn) and
  the view still returns; release is not called when the line lookup fails.
- **Claim Cart** — no inventory call.
- **Place Order** — allocate called inside the transaction after `markConverted`,
  with the `orderId` + snapshotted lines, and before payment authorization; an
  allocate rejection → no payment, no events, error propagates, no compensation; a
  CAS loss → allocate never called; a post-allocate commit failure → a
  `cancelAllocation` compensation (reason `place-rollback`) fired best-effort with
  the original error rethrown; a repeat place → no re-allocation.

End-to-end, the existing cart/order suites
(`cart-operations`, `cart-to-order-walking-skeleton`, `guest-cart-promotion`,
`order-list-my-orders`) now boot the inventory microservice as well, so the live
reserve/allocate hops run against real RabbitMQ + MySQL + Redis. Because those
suites now consume seeded stock and run against one shared DB, the inventory
availability suite reads a **disjoint, never-consumed seeded variant** for its
absolute `available === 100` assertions (the disjoint-fixtures convention).

## 6. Known gaps

- A failed best-effort release (Remove) or a failed compensation (Place) **over-
  holds stock** until the manual release endpoint or a later TTL sweeper reclaims
  it. The hold is never lost, only delayed in returning to `available`.
- `CartView` carries **no reservation state** — the holds are an inventory-side
  concern not surfaced in the cart's HTTP contract by this capability.
- The reservation RPCs still have **no gateway HTTP route** of their own; they are
  reachable only retail → inventory over RMQ. A manual release/audit HTTP surface
  is a later inventory capability.
