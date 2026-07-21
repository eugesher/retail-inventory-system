---
title: Tax computation engine
cluster: Order Management
effort: 2–3 capabilities
attaches_to:
  - apps/retail-microservice/src/modules/orders/domain/order-line.model.ts
  - apps/catalog-microservice/src/modules/pricing/domain/tax-category.model.ts
---

# Tax computation engine

## Description

Sales tax, VAT and GST are computed from *where the buyer is, what they bought, and who is selling* —
a matrix no shop maintains by hand at scale. A tax engine is the call-out that resolves the right amount:
Avalara, TaxJar and Vertex are the specialist providers, and platforms integrate them at a single point
in the checkout so the number is right for every jurisdiction the shop ships to.

The core already has the **seam waiting**: an order line carries a `taxAmountMinor` field and the order
a `taxTotalMinor`, both **captured, not computed** — they exist, default to `0`, and are frozen at
placement like any other money snapshot. The shop's tax feature today is a **label only** — the
[`Not built yet` ledger](../../../README.md#14-not-built-yet) records exactly this: *"Tax rates and
jurisdictions — `TaxCategory` is a label only."* This guide is the capability that fills that gap.

This guide **owns the tax call-out seam** — the point in the order flow where an external engine is
asked and what is stored. A later pricing-side tax-rate-tables guide is the *alternative* implementation
(internal rate tables instead of an external engine) that plugs into the same seam; it inherits the port
and the storage decision made here.

## Business needs

- **Multi-jurisdiction selling** — the moment a shop ships across a tax boundary (US state lines, EU VAT,
  cross-border), hand-maintained rates stop being viable.
- **Correct-at-purchase** — tax is part of the buyer's contract; it must be computed at placement and
  frozen, never recomputed later when rates have moved.
- **Audit and filing** — the computed amount and the engine's calculation reference have to be stored
  for reconciliation and returns, not just displayed.
- The threshold: a single-jurisdiction shop can hard-code one rate; the first out-of-region sale is
  where a real engine has to answer.

## Attachment points in the current core

- **`OrderLine` at
  `apps/retail-microservice/src/modules/orders/domain/order-line.model.ts`.** `taxAmountMinor` already
  exists, defaults to `0`, and is a **place-time snapshot** — the constructor derives `lineTotalMinor =
  unitPriceMinor × quantity + taxAmountMinor − discountAmountMinor`, and its own comment notes tax is
  currently `0` because there is no tax capability yet. This is the storage seam: a real engine writes a
  real number here, and the total invariant already accommodates it.
- **`Order.taxTotalMinor`** (same module, `order.model.ts`) — the header roll-up, also `0` today, which
  the order's total invariant already sums into `grandTotalMinor`. No money-model change is needed to
  hold tax; only to compute it.
- **`TaxCategory` at
  `apps/catalog-microservice/src/modules/pricing/domain/tax-category.model.ts`** — a classification
  **label only**, carrying `code` + `name`, **no rate and no jurisdiction** (its own comment says so). A
  variant points at one via the nullable `product_variant.tax_category_id` FK. This label is the *input*
  the engine keys on (variant → tax code → the provider's product tax category), not the computation.

## Implementation sketch

- **A `TAX_ENGINE` port**, mirroring `PAYMENT_GATEWAY`: `quote(request) → per-line tax`. The bound
  adapter calls the external provider from `infrastructure/`; a default adapter can return `0` (today's
  behaviour) so the seam exists before a provider is wired.
- **The call-out point is place-time**, in the place-order flow, between snapshotting the lines and
  deriving the totals — the engine is asked with the destination `Address`, the line SKUs/tax codes and
  amounts, and the answer is written into each line's `taxAmountMinor` before the order freezes.
- **Store the result, never recompute it.** Because `Order`/`OrderLine` are immutable, the tax amount is
  frozen at placement — the buyer's contract — exactly like `unitPriceMinor`. The engine's opaque
  **calculation reference** is stored alongside (for audit and filing), the way `gatewayReference` is
  stored but never parsed. A later rate change cannot alter a placed order.
- **The `TaxCategory` label is the engine's key**, unchanged — no rate lives on it. This is precisely the
  seam the tax-rate-tables guide reuses when it supplies an *internal* adapter for the same port.
- **Events** ride `ris.events` — nothing new is required, since tax rides inside the existing
  `retail.order.placed` totals; a `retail.order.tax-quoted` event is optional for audit. **No PII in the
  payload** (ADR-037): a jurisdiction is derived from the address, but the address itself stays out of
  the event.
- **Shared types** (the tax-quote request/response) under `libs/contracts/<cluster>/`.

## Open design questions

- **Quote at cart display vs. commit at place.** Tax usually has to show in the cart before checkout,
  which means an *estimate* call earlier and a *committed* call at place — two calls, and a decision about
  what happens if they disagree.
- **Address completeness** — tax needs a full destination, but the cart may only know a postal code early;
  how precise the estimate can be before full address entry is a UX-versus-accuracy trade.
- **Tax-inclusive vs. tax-exclusive pricing** — VAT markets quote prices tax-inclusive, US markets
  tax-exclusive; whether the ledger price already includes tax changes where the engine subtracts vs.
  adds.
- **Provider outage at place** — if the engine is down at checkout, does placement fail, fall back to a
  cached rate, or proceed at `0` and reconcile? This is the same fail-open/closed dilemma the risk seam
  faces.
- **Refund tax** — a partial refund has to return the proportional tax, which the returns flow must ask
  the engine (or reverse from the stored amount) to compute.

## Effort sketch

`2–3 capabilities` — the tax-engine port and adapter, the place-time call-out writing into the existing
`taxAmountMinor` seam, and the estimate/commit split for cart display. It stays this size because the
**storage already exists** and is captured-not-computed; the work is the call-out, not a money-model
change.
