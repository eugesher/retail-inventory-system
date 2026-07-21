---
title: Bin, aisle and shelf locations
cluster: Inventory
effort: 2–3 capabilities
attaches_to:
  - apps/inventory-microservice/src/modules/stock/domain/stock-location.model.ts
  - apps/inventory-microservice/src/modules/stock/domain/stock-level.model.ts
---

# Bin, aisle and shelf locations

## Description

A warehouse of any size needs to know not just *that* a location holds 40 units of a variant, but
*where in the building* those units sit: aisle 12, rack B, shelf 3, bin 07. This is directed
put-away and directed picking — the difference between a picker walking a route and a picker
searching. The core has one level of place, `StockLocation`, and nothing below it.

The tempting shortcut is to model each bin as another `StockLocation`. This guide argues against that
and explains why the sub-location is a new axis *inside* a location, not a peer of it. WMS-grade
systems (Manhattan, Blue Yonder, NetSuite WMS) all keep a location/bin hierarchy for exactly the
reason below: the bin is a picking detail, not a shipping origin.

## Business needs

- **Multi-aisle warehouses** need directed put-away and pick paths; without bins, every pick is a
  search.
- **High-SKU-count operations** need to split one variant's stock across many slots and still answer
  "where is it".
- **Cycle counting** is done bin-by-bin, not location-by-location.
- The threshold: a single-room store or a small stockroom never needs this; a warehouse a picker
  cannot memorise does.

## Attachment points in the current core

- **`StockLocation`, at `apps/inventory-microservice/src/modules/stock/domain/stock-location.model.ts`.**
  It has a **caller-assigned string PK**, a `code`, a `type` (`warehouse` / `store` /
  `dropship-virtual`), an optional GLN and an `active` flag. Crucially, it is the unit that stock
  **reservations, allocations and movements all key on** via `stockLocationId` — it is the place an
  order ships *from* and a hold is taken *against*.
- **`StockLevel`, at `apps/inventory-microservice/src/modules/stock/domain/stock-level.model.ts`.** Its
  natural key is `(variantId, stockLocationId)`. A bin axis would sit under that key — the totals and
  the `available` getter are what a bin dimension sub-divides.

## Implementation sketch

- **A bin is NOT a `StockLocation`.** The reason is load-bearing: `StockLocation` is the granularity
  of *fulfilment* — reservations, the no-oversell guard, commit-sale and the ledger all key on
  `stockLocationId`. A cart's hold must be taken against "the west warehouse", not "the west
  warehouse, aisle 12, bin 07" — pinning a shopper's TTL hold to a physical bin makes put-away
  (moving stock between bins) invalidate live holds, and makes cross-bin availability (the number the
  storefront needs) a sum you cannot take without enumerating every bin. So bins are modelled as a
  **sub-axis under the level**, not as peer locations.
- **Add a `Bin` (slot) descriptor** keyed `(stockLocationId, binCode)` with aisle/rack/shelf
  attributes, and a `BinPlacement` sub-record splitting a level's on-hand across bins:
  `(variantId, stockLocationId, binCode) → quantity`. The authoritative `available` stays at the
  `(variantId, stockLocationId)` level — the sum of its bin placements — so no-oversell is unchanged
  and reservations keep their current key.
- **Movements gain a bin, optionally.** A put-away or pick can record `binCode` on the
  `StockMovement`; the ledger stays append-only. A bin-to-bin move within one location is a pair of
  offsetting `adjustment` rows (the [transfer](transfer-order-documents.md) pattern in miniature),
  never an edit.
- **Directed put-away / pick** is a read-side strategy (nearest empty bin, pick-path order) over the
  `BinPlacement` rows — a port, injected, so the slotting rule is per-deployment. No new transport;
  any bin events ride `ris.events`.

## Open design questions

- **Is bin-level stock part of availability, or only a pick hint?** If the storefront never needs
  per-bin numbers, `BinPlacement` can be advisory (a picking layer) rather than a second source of
  truth that must reconcile with the level's counters.
- **One variant across many bins, and one bin across many variants** — both are normal, so the
  placement table is a full N↔N. Whether a bin enforces single-variant occupancy is a policy call.
- **Does the hierarchy need real depth** (zone → aisle → rack → shelf → bin) as nested entities, or is
  a flat bin with descriptive attributes enough? Depth buys pick-path optimisation and costs modelling
  weight.
- **Reservations at bin granularity for pick-to-order** — a genuine exception to the "hold at the
  location" rule above, for operations that stage picks. If needed, it re-keys the reservation the way
  [lot tracking](lot-batch-serial-tracking.md) does.

## Effort sketch

`2–3 capabilities` — the `Bin` descriptor, the `BinPlacement` sub-axis under the level, and the
directed put-away/pick strategy. It deliberately leaves the authoritative counters and the reservation
key where they are, which is what keeps it below subsystem-scale.
