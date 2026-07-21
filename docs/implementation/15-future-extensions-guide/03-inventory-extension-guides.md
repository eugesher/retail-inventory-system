# 03 — Inventory extension guides

The eight Inventory guides under [`docs/extensions/`](../../extensions/) sketch how a business would
grow the stock module past the universal core. This cluster is the one where the existing code sits
closest to the extension — several guides attach to a ledger and a totals aggregate that already carry
hard invariants — so the discipline here is less "invent a design" than "add an axis without breaking
what the core already guarantees". Every path, counter, movement type and port surface named below was
read out of the source, not from prior notes.

## The eight guides

### [lot-batch-serial-tracking.md](../../extensions/lot-batch-serial-tracking.md)

- **Claim.** Adds a lot/batch/serial identity axis below the variant, with serial as the degenerate
  lot-of-one.
- **Attaches to.** `StockLevel`, `StockMovement` and `Reservation` in
  [`apps/inventory-microservice/src/modules/stock/domain/`](../../../apps/inventory-microservice/src/modules/stock/domain/)
  — the three models a lot axis reshapes at once.
- **Hardest to reverse.** Splitting the running totals from `(variantId, stockLocationId)` to
  `(variantId, stockLocationId, lotId)`. Once availability is computed per lot, un-splitting it is a
  data migration, not a refactor. It owns this decision for the two guides that build on it.

### [expiry-fifo-rotation.md](../../extensions/expiry-fifo-rotation.md)

- **Claim.** An `expiresAt` per lot plus a pluggable FEFO/FIFO allocation policy.
- **Attaches to.** The same three domain models, and the lot axis from the guide above.
- **Hardest to reverse.** Making lot selection a policy at allocation. Whether the choice is FEFO,
  FIFO or configurable propagates into every allocate path; hard-coding "any lot" now would block it
  later.

### [bin-aisle-shelf.md](../../extensions/bin-aisle-shelf.md)

- **Claim.** Sub-location slotting (aisle/rack/shelf/bin) for directed put-away and picking.
- **Attaches to.** `StockLocation` and `StockLevel`.
- **Hardest to reverse.** The call that a bin is **not** a `StockLocation` but a sub-axis under the
  level (see the closing section). Modelling bins as peer locations would re-key reservations and the
  no-oversell guard onto bins — expensive to walk back.

### [demand-forecasting-and-safety-stock.md](../../extensions/demand-forecasting-and-safety-stock.md)

- **Claim.** A read-model forecast of demand and a computed safety stock / reorder point. **Owns the
  "the `stock_movement` ledger is the fact table" argument** the ABC guide then links.
- **Attaches to.** `StockMovement` and the event store's `domain_event` log at
  [`apps/event-store-microservice/src/modules/audit-and-events/domain/domain-event.model.ts`](../../../apps/event-store-microservice/src/modules/audit-and-events/domain/domain-event.model.ts).
- **Hardest to reverse.** Whether the forecasting read model is a separate deployable or a projection
  colocated in inventory. The seam (consume the event stream, expose a forecast port) is stable; the
  deployment boundary is not cheap to move later.

### [transfer-order-documents.md](../../extensions/transfer-order-documents.md)

- **Claim.** Wraps the core's atomic transfer in a draft→dispatched→received document with a lifecycle.
  Owns the transfer-document premise the in-transit guide links.
- **Attaches to.**
  [`transfer-stock.use-case.ts`](../../../apps/inventory-microservice/src/modules/stock/application/use-cases/transfer-stock.use-case.ts)
  and `StockMovement`.
- **Hardest to reverse.** Splitting the single atomic move into a timed dispatch and receipt. That
  introduces an in-transit period the core has never had, and every availability read at either
  endpoint must then account for it.

### [consigned-vendor-managed-inventory.md](../../extensions/consigned-vendor-managed-inventory.md)

- **Claim.** An ownership axis on stock so a supplier can own on-hand units; title transfers at
  commit-sale. Links [supplier-and-vendor.md](../../extensions/supplier-and-vendor.md) and re-models
  the party in no way.
- **Attaches to.** `StockLevel` (ownership is a new axis on a total that has none) and `StockMovement`.
- **Hardest to reverse.** Deciding when title transfers — at sale, receipt or period boundary — because
  that is what fixes when a payable to the supplier is created, and the accounting hangs off it.

### [abc-classification.md](../../extensions/abc-classification.md)

- **Claim.** Pareto A/B/C tiers scored off the ledger by a periodic job. Reads the fact table the
  demand-forecasting guide establishes.
- **Attaches to.** `StockMovement` and [`libs/cache/cache-keys.ts`](../../../libs/cache/cache-keys.ts).
- **Hardest to reverse.** The scoring dimension — value, volume or margin. It defines what an "A item"
  *is*, and everything downstream (cycle counting, purchasing policy) inherits it.

### [in-transit-as-separate-location.md](../../extensions/in-transit-as-separate-location.md)

- **Claim.** Models the dispatch-to-receipt gap as a virtual `StockLocation`, reusing the existing
  `dropship-virtual` precedent. Links [transfer-order-documents.md](../../extensions/transfer-order-documents.md).
- **Attaches to.** `StockLocation`.
- **Hardest to reverse.** Whether in-transit stock counts as available-to-promise at the destination.
  That decides if the `available` getter includes inbound units, and thus whether backorder-against-inbound
  is possible.

## The four invariants an inventory extension has to survive

The stock module enforces four guarantees in code. A sketch that quietly breaks one is worse than no
sketch, so each guide was checked against all four.

1. **No-oversell — `available` is derived, never stored.** In
   [`stock-level.model.ts`](../../../apps/inventory-microservice/src/modules/stock/domain/stock-level.model.ts)
   `available` is a getter (`onHand − allocated − reserved`) and the `reserve` / `allocateDirect` guards
   raise `OUT_OF_STOCK` on the last unit. Any guide that adds an axis must either **split the totals
   row** so availability stays derivable per partition, or explain how the sum stays honest. *Lot*,
   *consignment* and *bin* all add an axis and all split (or sub-divide) the row rather than hand-wave;
   the availability sum is stated in each.

2. **The movement ledger is append-only with a fixed sign per type.**
   [`stock-movement.repository.port.ts`](../../../apps/inventory-microservice/src/modules/stock/application/ports/stock-movement.repository.port.ts)
   offers only `append` / `listByVariant` / `existsByReference` — no `save`, `update` or `delete` — and
   the sign per type is re-asserted on read. A sketch that needs to change a recorded movement proposes
   a **compensating movement** and says so: *transfer* cancellation, *expiry* write-off and *bin*-to-bin
   moves are all phrased as new signed rows, never edits.

3. **A reservation is a TTL-bounded hold with an all-statuses uniqueness key.**
   [`reservation.model.ts`](../../../apps/inventory-microservice/src/modules/stock/domain/reservation.model.ts)
   is unique on `(cartId, variantId, stockLocationId)` across every status so a released hold can
   reactivate. *Lot tracking* is the guide that changes this key — to
   `(cartId, variantId, stockLocationId, lotId)` — and it names the new key explicitly; the others
   deliberately leave the reservation where it is.

4. **Cache invalidation on stock is type-enforced.**
   [`stock-cache.port.ts`](../../../apps/inventory-microservice/src/modules/stock/application/ports/stock-cache.port.ts)
   exposes only the two composed operations `getOrLoad` and `withInvalidation` — no public `invalidate`,
   no raw `get`/`set` ([ADR-023](../../adr/023-cache-invalidate-post-commit-by-type.md),
   [ADR-049](../../adr/049-the-port-methods-nothing-calls.md)). Every guide that caches a new read
   (*forecast*, *ABC class*, *lot facet*) rides one of those two, and none invents a raw key. The ABC
   guide additionally notes honestly that no inventory read-cache builder exists in
   [`cache-keys.ts`](../../../libs/cache/cache-keys.ts) today — the reserved families there are catalog,
   retail and notifications — so it would add a new one to the same version-segmented shape rather than
   claim one already fits.

## Why a bin is not a `StockLocation`

This is the call a reader will most want justified, and [bin-aisle-shelf.md](../../extensions/bin-aisle-shelf.md)
answers it: a bin is a **sub-axis under the level, not a peer location**.

The reason is that `StockLocation` is the granularity of *fulfilment*. Reservations, the no-oversell
guard, commit-sale and every ledger row key on `stockLocationId` — it is the place an order ships
*from* and a cart's TTL hold is taken *against*. Modelling each bin as its own `StockLocation` would
pin a shopper's hold to a physical bin, so ordinary warehouse put-away (moving stock between bins)
would invalidate live holds, and the cross-bin availability the storefront needs would become a sum
you cannot take without enumerating every bin of the variant. So the authoritative counters stay at
`(variantId, stockLocationId)`, and bins are a `BinPlacement` sub-record splitting that on-hand across
slots — a picking layer, not a second source of truth.

The one honest exception is pick-to-order staging, where a reservation genuinely wants bin
granularity; that case re-keys the reservation the same way lot tracking does, and the guide flags it
rather than pretending the rule is absolute.

The mirror-image decision sits one guide over: an **in-transit** place *is* a `StockLocation` (a
virtual one, on the existing `dropship-virtual` precedent), because it is a place stock moves *through*
between two fulfilment locations, not a subdivision of one. Bin: below a location. In-transit: between
locations. The `StockLocation` aggregate is the right tool for the second and the wrong tool for the
first, and saying which is which is the substance of both guides.
