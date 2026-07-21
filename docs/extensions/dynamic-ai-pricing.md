---
title: Dynamic and AI-driven pricing
cluster: Pricing & Promotions
effort: 2–3 capabilities
attaches_to:
  - apps/catalog-microservice/src/modules/pricing/domain/price.model.ts
---

# Dynamic and AI-driven pricing

## Description

**Dynamic pricing** moves a variant's price automatically in response to demand, competitor prices,
inventory levels, or time — the airline/hotel model, now common in retail for high-velocity or perishable
goods. **AI-driven pricing** is the same loop with a model choosing the number: a repricing engine ingests
signals, predicts a revenue-optimal price, and updates the catalogue on a schedule. Amazon's continuous
repricing, and the repricer ecosystem around marketplaces, are the reference shape.

The critical fact this guide rests on, read from the code: the `Price` ledger is
**append-only-for-history**. A repricing engine **writes new rows; it never mutates them.** A price the
model set last hour is not overwritten when the model sets a new one — it is *closed*, and the new price is
a new row. That is not a limitation to work around; it is exactly what makes an automated repricer
auditable, which a regulator or a disputing customer will eventually demand. This guide is the automation
*driving* the existing write path, not a new pricing model.

## Business needs

- **High-velocity and perishable goods** — a price that should fall as stock ages or a departure nears
  cannot be hand-managed; the reprice has to be automatic and frequent.
- **Competitive markets** — matching or beating a competitor's live price is a marketplace necessity where
  buyers sort by price, and it changes faster than a human can keep up.
- **Demand-responsive revenue optimisation** — a model that lifts price under scarcity and drops it to
  clear slow stock captures margin a flat price leaves on the table.
- **Auditability of an automated change** — precisely *because* a machine is setting prices, every change
  must be attributable and reconstructable, which raises the bar the append-only ledger already clears.
- The threshold: a shop with a stable catalogue and manual price reviews never needs this; the first
  category where price must track demand or a competitor faster than staff can is where a repricer earns
  its complexity.

## Attachment points in the current core

- **The append-only `Price` ledger at
  `apps/catalog-microservice/src/modules/pricing/domain/price.model.ts`.** A reprice is a `Price.set` — a
  new row for the new amount — plus the automatic `close` of the predecessor's open interval, both in the
  one transaction `appendPrice(newPrice, predecessorToClose)` runs. The engine **never edits `amountMinor`
  in place**; there is no setter for it, by design (ADR-026 §1). Every price the model ever chose, and the
  window it applied to, stays as a closed row — a complete, queryable history of the algorithm's decisions.
- **The `SetPrice` write path** (`set-price.use-case.ts`) — the engine drives exactly this, through the
  existing `catalog.price.set` RPC. An immediate reprice emits `catalog.price.changed`; a scheduled future
  price (the engine pre-computing tomorrow's price) emits `catalog.price.scheduled`. The engine needs no
  new write surface — it is a new *caller* of the one that exists.
- **The publish probe `ACTIVE_PRICE_PROBE`** (`active-price-probe.port.ts`) — catalog's own read of the
  `price` table gating `PublishProductUseCase` on "≥1 active price". A repricer must never drive a variant's
  active price to a state that fails this probe (e.g. leaving a scope with no open row), or it would silently
  unpublish the product. That interaction is the engine's to respect.

## Implementation sketch

- **A repricing engine as a driver of the write path, not a new model.** The engine lives in
  `infrastructure/` (or a sidecar service) behind a port; it ingests signals — demand from the
  `stock_movement` and `retail.order.placed` streams the event store already captures, competitor feeds,
  inventory from the stock context — and calls `catalog.price.set` with the computed amount. The domain
  model is unchanged.
- **Frequency and floor/ceiling guards.** An automated reprice needs bounds the engine cannot cross — a
  minimum margin, a maximum swing per interval, a floor and ceiling — enforced *before* the write, so a bad
  signal or a model error cannot set an absurd price. These guards are policy the engine carries, not domain
  invariants (the domain only checks amount ≥ 0 and the interval).
- **Scheduling reuses the ledger's native support.** The engine can pre-compute and *schedule* a future
  price with `validFrom > now`; `SetPrice` closes the current row exactly at that instant, so the current
  answer is unchanged until the schedule arrives — no cron flipping a flag, just a future-dated row.
- **The audit trail is free.** Because every reprice is a closed row, "why was the price X at time T, and
  what did the model see" is answerable from the ledger plus the signals the engine logged — no extra
  audit machinery, the history *is* the ledger.
- **Events ride `ris.events`** — the existing `catalog.price.changed` / `catalog.price.scheduled`, no new
  transport. **No PII** (ADR-037): pricing signals are demand and inventory aggregates, never buyer
  identities.

## Open design questions

- **Where the engine runs** — an in-process scheduled job in catalog, or a separate service that calls the
  `catalog.price.set` RPC. A separate service isolates the model's compute and dependencies but adds a hop;
  an in-process job is simpler but couples model runtime to the catalog deployable.
- **How aggressively to reprice** — every signal change, or batched on a cadence. Continuous repricing
  writes many ledger rows (history grows fast); batching is cheaper but stale between runs. The ledger
  tolerates either, but the row volume is a real operational cost.
- **Explainability and governance** — an AI-set price may need a human-readable reason and an override path,
  especially where price discrimination is regulated. The ledger records *what*; the engine owes *why*.
- **Guard-rail authority** — who sets the floor/ceiling, and whether a model can ever be allowed to breach
  them, is a business-control decision, not a modelling one.
- **Interaction with promotions and contract prices** — a repricer moves the *base* list price; a promotion
  or a contract price sits on top or overrides. The engine must reprice the public scope without clobbering
  a group or account scope, once those exist.

## Effort sketch

`2–3 capabilities` — the signal-ingesting repricing engine behind a port, the floor/ceiling and frequency
guards, and the scheduling that pre-dates future prices. It stays this size **because** it writes through
the existing append-only ledger and `SetPrice` path unchanged — the hard problems (history, scheduling,
audit) are already solved by the model it drives; the new work is the engine and its guard-rails.
