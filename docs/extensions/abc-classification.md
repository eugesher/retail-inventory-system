---
title: ABC classification
cluster: Inventory
effort: 1 capability
attaches_to:
  - apps/inventory-microservice/src/modules/stock/domain/stock-movement.model.ts
  - libs/cache/cache-keys.ts
---

# ABC classification

## Description

ABC classification ranks a catalogue's variants into tiers by their contribution — the Pareto split
where a small set of A items drives most of the value, a middle band of B items, and a long tail of C
items. It is what tells a planner where to spend attention: tight control and frequent counts on A
items, loose policy on C. The core keeps no such ranking; every variant is treated identically.

This is a **pure read-side classification** — a periodic scoring over history, no counter touched. It
reads the same `stock_movement` ledger that [demand forecasting and safety
stock](demand-forecasting-and-safety-stock.md) establishes as the inventory fact table; that guide
owns the fact-table argument and this one consumes it.

## Business needs

- **Inventory planning at scale** needs a way to focus control effort on the variants that matter.
- **Cycle-count scheduling** counts A items often and C items rarely — impossible without the tiers.
- **Purchasing and safety-stock policy** is set per class, not per variant, once the catalogue is too
  large to tune individually.
- The threshold: a small catalogue is managed variant-by-variant; a large one needs the classes.

## Attachment points in the current core

- **`StockMovement`, the fact table, at `apps/inventory-microservice/src/modules/stock/domain/stock-movement.model.ts`.**
  ABC scores variants by movement value or volume over a window — `sale` rows (strictly negative,
  fixed sign) are the consumption signal. The ledger is read, never written, by this capability, so its
  append-only invariant is untouched. See [demand forecasting and safety
  stock](demand-forecasting-and-safety-stock.md) for why the ledger is the right source.
- **`CACHE_KEYS`, at `libs/cache/cache-keys.ts`.** A variant's class is a stable, expensive-to-compute
  read — a natural cache-aside value. Note honestly: the reserved builders in this file today are
  catalog, retail and notifications families; **there is no inventory read-cache builder yet**, so this
  adds a new `inventoryAbc`-style family following the same shape (a version segment, a prefix builder
  for `delByPrefix` invalidation).

## Implementation sketch

- **A recompute job, like the reservation sweep.** A scheduled job
  ([ADR-038](../adr/038-reservation-ttl-sweep-and-bounded-batches.md) is the registered-interval
  precedent) periodically scores every variant over a trailing window and assigns a class. It mutates
  no `StockLevel` and appends no `StockMovement` — classification is a projection, not a transaction.
- **Store the class as a small read model** keyed on `(variantId[, stockLocationId])`, holding the tier
  and the score it was assigned from. Whether the class is per-variant globally or per-location is an
  open call.
- **Cache the class read** through the existing `getOrLoad` / `withInvalidation` seam
  ([ADR-016](../adr/016-cache-aside-generalized.md) / [ADR-023](../adr/023-cache-invalidate-post-commit-by-type.md)),
  invalidated when the recompute job publishes a new set — never a raw key literal in `apps/`, always a
  `CACHE_KEYS` builder.
- **Events** are optional and ride `ris.events` if a class change needs to notify downstream (e.g.
  `inventory.variant.reclassified`); no new transport. Shared class views under
  `libs/contracts/inventory/` if they cross a service boundary.

## Open design questions

- **Value, volume, or margin?** A-by-revenue, A-by-units-sold and A-by-margin produce different splits.
  Which dimension (or a weighted blend) defines the class is the core policy call.
- **Recompute cadence and window.** A trailing 30/90/365-day window, recomputed nightly or weekly —
  too short chases noise, too long lags demand shifts.
- **Global vs per-location class.** A variant may be an A item at one store and a C at another; a single
  global class is simpler but coarser.
- **What consumes the class?** If nothing downstream reads it (cycle counting, purchasing policy), the
  classification is decoration. Naming the consumer is what keeps this a capability rather than a
  report.

## Effort sketch

`1 capability` — a single scheduled scoring job, a small class read model, and its cached read. It
writes nothing transactional and reuses the ledger that [demand forecasting and safety
stock](demand-forecasting-and-safety-stock.md) already treats as the fact table, so it is genuinely
one slice of work.
