---
title: Demand forecasting and safety stock
cluster: Inventory
effort: 2–3 capabilities
attaches_to:
  - apps/inventory-microservice/src/modules/stock/domain/stock-movement.model.ts
  - apps/event-store-microservice/src/modules/audit-and-events/domain/domain-event.model.ts
---

# Demand forecasting and safety stock

## Description

The core reacts to depletion: when `available` crosses a threshold it emits `inventory.stock.low`,
and a human reorders. It never *predicts* depletion. A business past a certain size needs the inverse
— a forecast of demand per variant and a computed **safety stock** and reorder point, so replenishment
happens before the shelf is empty rather than after. This is the read side of inventory: no counter is
mutated, a projection is computed from history.

The history is already there. This guide owns the argument the whole cluster leans on: **the
`stock_movement` ledger is the fact table.** Every receipt, sale, allocation, release and adjustment is
a timestamped, signed, typed, immutable row — precisely the grain a forecast consumes. Vendure and
Saleor leave forecasting to external analytics; NetSuite and Adobe Commerce ship demand planning as a
distinct module for the same reason it is an extension here — it is an analytics workload, not a
transactional one.

## Business needs

- **Any business that reorders stock** wants to reorder on a forecast, not on a stock-out.
- **Seasonal and promotional demand** needs a model that reads trend and seasonality out of sale
  history, not a static min/max.
- **Safety stock** — the buffer that absorbs demand and lead-time variance — must be computed per
  variant and location, not guessed.
- The threshold: a shop reordering a handful of lines by eye never needs this; a catalogue too large
  to plan by hand does.

## Attachment points in the current core

- **`StockMovement`, the fact table, at `apps/inventory-microservice/src/modules/stock/domain/stock-movement.model.ts`.**
  It is append-only, immutable and signed-per-type (`sale` strictly negative, `receipt` positive) —
  so `sale` rows over time *are* the demand series, and `receipt` rows are the supply series. Nothing
  needs to be added to the ledger to forecast from it; it is read, never written, by this capability.
- **The event store's `domain_event` log, at `apps/event-store-microservice/src/modules/audit-and-events/domain/domain-event.model.ts`.**
  Every `inventory.stock.*` event already flows onto `ris.events` and is captured by the firehose into
  the append-only `domain_event` log
  ([ADR-035](../adr/035-event-store-firehose-topic-exchange.md)). A forecasting read model can be built
  as a **consumer of that stream** rather than by querying the operational ledger directly — the
  cleaner seam for an analytics workload that must not load the transactional path.
- **The existing low-stock signal** — `inventory.stock.low` — is the threshold event a computed safety
  stock would make dynamic instead of static.

## Implementation sketch

- **A forecasting read model, not a mutation.** It computes, per `(variantId, stockLocationId)`, a
  demand forecast and a derived reorder point and safety-stock level. It writes no `StockLevel` and no
  `StockMovement` — the append-only ledger and the no-oversell invariant are untouched because this
  capability never touches a counter.
- **Consume the stream.** A new read-model context (a candidate new deployable, `apps/<name>/`, under
  [ADR-018](../adr/018-nestjs-monorepo-apps-and-libs.md) — or a projection colocated in inventory, see
  Open questions) subscribes to `inventory.stock.*` on `ris.events` and maintains a per-variant demand
  aggregate. No new transport, no new broker.
- **Safety stock feeds the low-stock threshold.** Rather than a fixed reorder point, the computed
  safety-stock level parameterises when `inventory.stock.low` should fire — the signal already exists;
  this makes its trigger dynamic.
- **Cache the forecast read** through the existing `getOrLoad` / `withInvalidation` seam with a
  version-segmented `CACHE_KEYS` builder ([ADR-016](../adr/016-cache-aside-generalized.md)); a forecast
  is expensive to compute and stable between recomputes, so it is a natural cache-aside read — never a
  raw key literal in `apps/`.
- **Shared forecast views** under `libs/contracts/inventory/` if the number crosses a service boundary
  (e.g. to a purchasing UI).

## Open design questions

- **In-house model or external service?** A moving average or exponential smoothing fits inside a Nest
  service; ARIMA/ML-grade forecasting argues for an external analytics platform the read model calls
  out to. The seam (consume the event stream, expose a forecast port) is the same either way.
- **Where does the forecasting read model live?** A separate analytics deployable keeps the heavy
  read workload off the transactional inventory service, but a colocated projection is simpler until
  volume forces the split. This is the call a reader will most want justified.
- **Static vs dynamic safety stock.** A per-variant column is simple; a computed buffer from demand and
  lead-time variance is correct but needs both distributions, and lead time comes from the
  [supplier](supplier-and-vendor.md) party, not from inventory.
- **Forecast horizon and recompute cadence.** Nightly batch over the ledger, or incremental on each
  sale event? The event-stream seam allows either.

## Effort sketch

`2–3 capabilities` — a demand read model over the ledger/event stream, a computed safety-stock and
reorder point, and the dynamic threshold wiring into the existing low-stock signal. It writes nothing
transactional, which is what keeps an analytics-flavoured capability this contained.
