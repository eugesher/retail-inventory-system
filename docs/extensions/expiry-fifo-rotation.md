---
title: Expiry dates and FIFO rotation
cluster: Inventory
effort: 2–3 capabilities
attaches_to:
  - apps/inventory-microservice/src/modules/stock/domain/stock-level.model.ts
  - apps/inventory-microservice/src/modules/stock/domain/stock-movement.model.ts
  - apps/inventory-microservice/src/modules/stock/domain/reservation.model.ts
---

# Expiry dates and FIFO rotation

## Description

Once stock is split into lots — the [lot, batch and serial tracking](lot-batch-serial-tracking.md)
guide owns that axis — a perishables business needs two more things the core has no notion of: an
**expiry date** per lot, and a **rotation policy** that decides which lot ships first. A grocer must
sell the milk that expires Tuesday before the milk that expires Friday (FEFO — first-expired,
first-out); a manufacturer draws raw materials in receipt order (FIFO). The core's allocation is
policy-free: `reserve` and `allocateDirect` draw against an undifferentiated total, so there is
nothing to rotate.

This guide adds the expiry attribute and the allocation policy that consumes it. It is a small delta
*on top of* lot tracking, not a standalone capability — with no lot axis there is nothing to date or
to rotate.

## Business needs

- **Perishable inventory** (grocery, pharma, cosmetics, chemicals) must not ship stock past its
  expiry, and should ship soonest-to-expire first to minimise write-offs.
- **Batch-controlled manufacturing** rotates raw materials FIFO for consistency and shelf-life
  compliance.
- **Near-expiry recovery** — surfacing lots about to expire for markdown or donation — is a reporting
  need that only exists once expiry is tracked.
- The threshold: any business whose goods lose value or legality on a date; a shop selling
  non-perishable goods never needs rotation.

## Attachment points in the current core

- **The `Lot` axis from [lot, batch and serial tracking](lot-batch-serial-tracking.md).** Expiry is a
  nullable `expiresAt` on the lot; this guide assumes that axis exists and adds one field plus the
  policy that reads it.
- **`StockLevel`, at `apps/inventory-microservice/src/modules/stock/domain/stock-level.model.ts`.** Its
  `available` getter (`onHand − allocated − reserved`) is what an *expired* lot must be excluded from —
  an expired lot's on-hand stays counted physically but is no longer sellable, a derived exclusion, not
  a counter mutation.
- **`Reservation`, at `apps/inventory-microservice/src/modules/stock/domain/reservation.model.ts`.** A
  hold already carries a wall-clock `expiresAt` for its **TTL**; lot expiry is a *different* clock (the
  goods', not the hold's) and must not be conflated with it.
- **`StockMovement`, at `apps/inventory-microservice/src/modules/stock/domain/stock-movement.model.ts`.**
  A write-off of expired stock is a negative `adjustment` movement (the only type that takes either
  sign) with a reason code — never a deletion, because the ledger is append-only.

## Implementation sketch

- **Add `expiresAt` to the lot** and an availability rule: a lot whose `expiresAt` has passed is
  excluded from the per-lot `available` sum a storefront reads. The exclusion is a derived filter, so
  no counter changes and the no-oversell invariant is untouched.
- **Make lot selection a policy at allocation.** When `reserve` / `allocateDirect` / `allocateFromReserved`
  must pick a lot, a FEFO policy orders candidate lots by `expiresAt` ascending; a FIFO policy orders
  by receipt date. The policy is a use-case-level strategy over the lot rows, injected as a port so the
  choice is per-deployment — never hard-coded in the aggregate.
- **Expiry is a sweep, like the TTL sweep.** A scheduled job
  ([ADR-038](../adr/038-reservation-ttl-sweep-and-bounded-batches.md) is the precedent — a bounded,
  registered interval) marks lapsed lots and writes the write-off `adjustment` movements in bounded
  batches. It emits on `ris.events` (`inventory.stock.adjusted` already exists) — no new transport.
- **Near-expiry is a read projection** over the lot rows, cacheable through the existing
  `getOrLoad` / `withInvalidation` seam with a version-segmented `CACHE_KEYS` builder, never a raw key
  literal in `apps/`.

## Open design questions

- **FEFO vs FIFO vs configurable.** Most perishables want FEFO, most manufacturing wants FIFO, and some
  businesses want it per category. Whether the policy is a global setting, a per-variant flag or a
  per-location rule is the central unresolved call.
- **What happens to a hold on a lot that expires mid-cart?** A reservation against a lot whose goods
  expire before checkout must be re-pointed to another lot or released — a race between the goods'
  clock and the hold's TTL that the flat model never had.
- **Block vs warn on expired allocation.** Should the system hard-refuse allocating an expired lot
  (a typed 409), or allow it with an override for clearance sales? Pharma says block; grocery
  clearance says warn.
- **Shelf-life on receipt vs fixed date.** Some goods carry an absolute expiry; others a shelf-life
  duration applied at receipt. The lot may need both a manufacture date and a computed expiry.

## Effort sketch

`2–3 capabilities` — the expiry field and its availability exclusion, the pluggable rotation policy at
allocation, and the expiry sweep. It rides entirely on the lot axis authored in
[lot, batch and serial tracking](lot-batch-serial-tracking.md); without that foundation it would itself
be subsystem-scale.
