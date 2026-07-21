---
title: In-transit as a separate location
cluster: Inventory
effort: 1 capability
attaches_to:
  - apps/inventory-microservice/src/modules/stock/domain/stock-location.model.ts
---

# In-transit as a separate location

## Description

When a [transfer order](transfer-order-documents.md) splits an atomic move into a timed dispatch and a
later receipt, a gap opens: stock has left the source but has not yet arrived at the destination. It is
neither place's on-hand, yet it exists and must be accounted for. This guide models that gap as a
**location of its own** — an in-transit place that stock moves *through* — reusing the core's existing
`StockLocation` aggregate rather than inventing a parallel concept.

It builds directly on the transfer document: with instantaneous transfers there is no in-transit
period to model, so this capability only earns its place once transfers take time. commercetools and
larger WMS platforms model in-transit as a virtual location for exactly this reason.

## Business needs

- **Multi-warehouse transfers that take days** need the goods visible somewhere between dispatch and
  receipt — "we have 100 units, 40 of them on a truck" is a real, reportable state.
- **Loss and shrinkage in transit** need a place to be reconciled against: dispatched-minus-received is
  a discrepancy held in transit, not a silent gap at either endpoint.
- **Accurate available-to-promise** must not count in-transit stock as sellable at the destination
  before it lands (unless the business deliberately backorders against it).
- The threshold: same-building or instantaneous transfers never need this; transfers with real
  duration do.

## Attachment points in the current core

- **`StockLocation`, at `apps/inventory-microservice/src/modules/stock/domain/stock-location.model.ts`.**
  It already supports a **virtual, non-physical location**: its `type` enum carries
  `dropship-virtual` alongside `warehouse` and `store`, and its PK is a **caller-assigned string**, not
  a generated id. An in-transit location is a small addition to that enum — the precedent for a place
  that holds stock without being a building already exists.
- **The [transfer order document](transfer-order-documents.md)** is what drives stock into and out of
  the in-transit location: dispatch moves source → in-transit, receipt moves in-transit → destination.
  This guide is the answer to that guide's central open question of where in-transit stock sits.

## Implementation sketch

- **Add an `in-transit` (or `transit-virtual`) member to `StockLocationTypeEnum`.** An in-transit
  location is then an ordinary `StockLocation` row of that type, with a caller-assigned code — no new
  aggregate, which is what makes this one capability rather than a subsystem.
- **A transfer becomes two moves instead of one.** Dispatch is a transfer from the source to the
  in-transit location; receipt is a transfer from in-transit to the destination. Each reuses the
  existing paired-`adjustment` ledger convention, so the append-only sign rule is untouched and every
  leg is queryable by its transfer reference.
- **Suppress fulfilment behaviours for the virtual location.** An in-transit location is not a place
  orders ship *from* or holds are taken *against* — so it must be excluded from the location list a
  storefront allocates over, the way a `dropship-virtual` location is treated specially. This exclusion
  is the real work of the capability.
- **Discrepancies reconcile in transit.** Units dispatched but never received are a loss `adjustment`
  against the in-transit location, giving shrinkage a home rather than a gap.
- **Events** ride `ris.events` unchanged — the transfer's dispatch/receipt events already describe the
  movement; the in-transit location just gives the intermediate leg a real endpoint.

## Open design questions

- **One shared in-transit location, or one per lane?** A single virtual location is simplest but blurs
  *which* transfer stranded stock; a per-route (source→destination) location makes discrepancies
  traceable at the cost of many virtual rows.
- **Is in-transit stock sellable?** Counting it as available-to-promise at the destination enables
  backorder-against-inbound; counting it as unavailable is safer. This is the call that decides whether
  the `available` getter at the destination includes inbound units.
- **Who owns the in-transit location's lifecycle?** If per-lane, they may be created on demand by the
  transfer document rather than provisioned up front — which pushes location creation into the transfer
  flow.
- **Multi-hop transfers** (source → hub → destination) chain in-transit legs; whether that is in scope
  or a later concern shapes how general the model must be.

## Effort sketch

`1 capability` — one new `StockLocationTypeEnum` member and the fulfilment-exclusion logic for virtual
locations, reusing the `StockLocation` aggregate and the transfer document's existing legs. It is small
precisely because [transfer orders as workflow documents](transfer-order-documents.md) already did the
structural work.
