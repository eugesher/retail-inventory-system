---
title: Lot, batch and serial tracking
cluster: Inventory
effort: subsystem-scale (5+ capabilities)
attaches_to:
  - apps/inventory-microservice/src/modules/stock/domain/stock-level.model.ts
  - apps/inventory-microservice/src/modules/stock/domain/stock-movement.model.ts
  - apps/inventory-microservice/src/modules/stock/domain/reservation.model.ts
---

# Lot, batch and serial tracking

## Description

The core tracks stock as a plain count: for one `(variantId, stockLocationId)` pair it keeps three
running totals and nothing that distinguishes one unit from another. A grocer, a pharmacy or an
electronics retailer cannot live with that — they must know *which* units are on hand, because units
of the same variant differ in ways that drive real decisions: a batch of yoghurt expires on a date,
a pharmaceutical lot can be recalled, a laptop's serial number is what a warranty claim keys on.

Lot/batch tracking adds an identity axis **below** the variant: many lots of one variant, each a
distinguishable sub-quantity. Serial tracking is the degenerate case — a lot of size one, one row per
physical unit. Saleor and Vendure leave this out of their cores for the same reason this system does;
NetSuite, SAP and Adobe Commerce (via extensions) treat it as a first-class inventory subsystem
because it reshapes availability, allocation and the audit ledger at once.

## Business needs

- **Perishables** (grocery, pharma, cosmetics) need a batch to hang an expiry date on — the rotation
  policy that consumes it is [expiry and FIFO rotation](expiry-fifo-rotation.md).
- **Regulated goods** (pharma, food, aerospace parts) need lot-level traceability for recalls: given a
  lot id, list every movement and every order that touched it.
- **High-value serialised goods** (electronics, appliances, firearms) need per-unit identity for
  warranty, theft and returns matching.
- The threshold: a shop selling fungible units that never expire and carry no warranty never needs
  this; the first regulated, perishable or serialised line is where the flat count stops being enough.

## Attachment points in the current core

- **`StockLevel`, at `apps/inventory-microservice/src/modules/stock/domain/stock-level.model.ts`.** It
  keys on `(variantId, stockLocationId)` and keeps `quantityOnHand` / `quantityAllocated` /
  `quantityReserved`, with `available` a **pure getter** (`onHand − allocated − reserved`), never a
  stored column. A lot axis splits this row: the totals a lot dimension would fragment are exactly
  these three counters.
- **`StockMovement`, at `apps/inventory-microservice/src/modules/stock/domain/stock-movement.model.ts`.**
  Every counter change already writes an immutable, `Object.freeze`-d ledger row with a fixed sign per
  type ([ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)). A lot id is an
  *intrinsic* dimension of the units that moved, so it is a new column on the movement — not a value
  for the polymorphic `referenceType` / `referenceId` pair, which names the originating *document*.
- **`Reservation`, at `apps/inventory-microservice/src/modules/stock/domain/reservation.model.ts`.** A
  hold today is unique on `(cartId, variantId, stockLocationId)` across all statuses. A hold against a
  *specific* lot changes that key.

## Implementation sketch

- **Split the totals by lot.** The running counters move from `(variantId, stockLocationId)` to
  `(variantId, stockLocationId, lotId)` — either a new `StockLevelByLot` sub-aggregate or a lot column
  on the level's natural key. `available` stays a getter, now computed **per lot**; the
  variant-location `available` a storefront reads is the **sum over lots**. The no-oversell guard
  (`reserve` / `allocateDirect` raising `OUT_OF_STOCK`) must hold both per lot and in aggregate — a
  reservation that fits the variant total but no single lot is the new failure mode to name.
- **Add a `Lot` (batch) aggregate**, keyed `(variantId, lotId)`, carrying the lot number, optional
  supplier reference and — consumed by the rotation guide — an optional `expiresAt`. A serial is a
  `Lot` with quantity fixed at one; decide (Open questions) whether serials get their own row shape.
- **Widen the ledger, keep it append-only.** `StockMovement` gains a nullable `lotId`; the append-only
  invariant is untouched (the port still offers only `append` / `listByVariant` / `existsByReference`,
  no `save`/`update`/`delete`). Recall traceability is a `listByVariant`-style query narrowed by lot.
- **Re-key the reservation** to `(cartId, variantId, stockLocationId, lotId)` when a hold is
  lot-specific. The all-statuses uniqueness that lets a released hold reactivate is preserved on the
  wider key.
- **Events** ride the existing dotted keys on `ris.events` — a `received` / `allocated` / `sale`
  movement simply carries its lot in the payload; no new transport, no new broker
  ([ADR-035](../../adr/035-event-store-firehose-topic-exchange.md)). Cross-service lot views go under
  `libs/contracts/inventory/`.
- **Cache:** the `inventoryStock` read view gains a lot facet the same way it already carries a
  location facet; it rides the existing `getOrLoad` / `withInvalidation` seam
  ([ADR-023](../../adr/023-cache-invalidate-post-commit-by-type.md)), never a raw `set`.

## Open design questions

- **How deep does the lot axis go?** Splitting `StockLevel` is unavoidable; but must *every*
  reservation and allocation pin a lot, or only lot-managed variants, with fungible variants keeping
  the flat single-lot row? A per-variant "lot-managed" flag keeps the common case cheap.
- **Serial as a lot-of-one, or a distinct model?** A quantity-one lot reuses everything here, but a
  serialised unit also has per-unit state (in service, RMA'd, scrapped) a lot does not — that may
  argue for a `SerialUnit` aggregate rather than a size-one `Lot`.
- **Allocation policy is deferred, but not free.** *Which* lot a `reserve` or `allocateDirect` draws
  from is a policy this guide leaves to [expiry and FIFO rotation](expiry-fifo-rotation.md); the shape
  here must not hard-code "any lot" in a way that later blocks FEFO.
- **Cost layering.** Lots often carry a per-lot cost (FIFO/weighted-average valuation). Whether that
  lives here or in a separate valuation concern is unresolved.

## Effort sketch

`subsystem-scale (5+ capabilities)` — it splits the totals aggregate, widens the append-only ledger,
re-keys the reservation uniqueness constraint, adds a `Lot` aggregate, and touches availability,
allocation and caching at once. It is the foundation two other inventory guides build on, so its shape
is load-bearing rather than local.
