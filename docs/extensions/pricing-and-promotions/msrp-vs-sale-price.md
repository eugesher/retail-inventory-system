---
title: MSRP versus sale price
cluster: Pricing & Promotions
effort: 1 capability
attaches_to:
  - apps/catalog-microservice/src/modules/pricing/domain/price.model.ts
---

# MSRP versus sale price

## Description

**MSRP versus sale price** is the "compare-at" price: the struck-through `~~£80~~` next to the live `£60`,
showing the customer what they are saving. The higher number is a *reference* price — a manufacturer's
suggested retail price, or the shop's own regular price — displayed alongside the *charged* price to
signal a discount. Shopify's `compare_at_price`, Adobe Commerce's special price, and WooCommerce's
regular/sale price fields all model this: two prices, one shown as the anchor and one as the deal.

This guide **owns the compare-at concept** — how a reference price is held and shown next to the charged
price. It leans on [discounts-and-promotions.md](discounts-and-promotions.md) for the machinery of an
*actual* reduction: that guide owns "how a discount is computed and stored", including the line between a
**scheduled sale** (a real ledger price change for everyone) and a **conditional promotion**. This guide
owns only the narrower, display-facing question — what the *was* price is and where it comes from — and
defers the reduction mechanics to the engine.

## Business needs

- **Discount signalling sells** — a visible "was £80, now £60" converts better than a bare £60; the
  compare-at price is a merchandising primitive, not an accounting one.
- **MSRP as a manufacturer anchor** — resellers show the manufacturer's suggested price to demonstrate
  value even when they never charged it, which is a distinct source from the shop's own regular price.
- **Regulatory honesty** — "was" pricing is regulated in many markets (the reference must be a price the
  shop genuinely charged, for a period); the compare-at value therefore may need provenance, not just a
  number a marketer typed.
- The threshold: a shop that only ever shows one price never needs this; the first sale it wants to
  *advertise as a saving* is where a second, reference price has to be modelled.

## Attachment points in the current core

- **The `Price` ledger's `priority` ordering at
  `apps/catalog-microservice/src/modules/pricing/domain/price.model.ts`.** The ledger already resolves *one*
  applicable price by **highest `priority`, then latest `validFrom`** (ADR-026 §4). A sale price is naturally
  a higher-`priority` row that overrides a lower-priority regular row for its interval — so the ledger can
  already express "the regular price and the current sale price" as two rows, the sale winning resolution.
  The compare-at concept sits on this: the *reference* to show is the regular (lower-priority, or
  most-recent-closed) row, while the *charged* price is the winning row.
- **The append-only history** — because a change *closes* the predecessor rather than overwriting it, the
  price a variant was sold at before a sale is a real, dated row. A regulator-safe "was" price is not a
  free-text field a marketer sets; it can be **derived from the ledger's own history** — the last regular
  price genuinely in effect before the sale.
- **The discount engine** ([discounts-and-promotions.md](discounts-and-promotions.md)) — owns the *actual*
  reduction. This guide references its sale-vs-promotion distinction: a scheduled sale is a ledger row (the
  compare-at is the regular row it overrides); a conditional promotion computes at checkout (the compare-at
  is the un-promoted line price). This guide does not re-argue where a reduction is computed.

## Implementation sketch

- **Model compare-at as a resolution over the ledger, not a new mutable field.** The charged price is the
  ledger's resolved answer; the compare-at is the reference row — the regular-priced row the sale overrides,
  or the last closed regular interval. Preferring a *derived* compare-at over a hand-typed one keeps it
  honest and reuses the history the ledger already keeps. An explicit MSRP (a manufacturer figure the shop
  never charged) is the one case that needs its own stored value, because it is not in the shop's price
  history — modelled as a distinct low-`priority` "reference-only" row or a labelled field, never resolved
  as the charged price.
- **Present both prices; charge one.** The read side returns the charged price and, when it differs, the
  compare-at plus the saving — a view-layer composition over the existing `SelectApplicablePrice` result,
  needing no write-path change.
- **Provenance for regulated "was" claims.** Where the market requires it, the compare-at carries the window
  the reference price was actually in effect — read straight from the closed ledger interval, so the claim
  is backed by data, not assertion.
- **Events ride `ris.events`** — nothing new; a sale is still a `catalog.price.changed` on the winning row.
  The compare-at is a read-side derivation, not an event. **No PII** (ADR-037).
- **Shared types** (the price view gains a compare-at and saving) under `libs/contracts/<cluster>/`.

## Open design questions

- **Derived compare-at vs. an explicit `compareAtMinor` field.** Deriving from ledger history is honest and
  self-maintaining but only works for prices the shop actually charged; an explicit field is needed for a
  true manufacturer MSRP but can be set to anything, raising the regulatory-honesty problem. Most shops need
  both, and which is the default matters.
- **What counts as the "regular" price** when several closed rows precede a sale — the immediately prior
  row, or the highest recent price? Regulated markets define this precisely (e.g. lowest price in the prior
  30 days), which a derivation has to encode.
- **MSRP source and staleness** — a manufacturer suggested price is externally sourced and goes stale; who
  updates it and how it is distinguished from the shop's own regular price is a data-ownership question.
- **Per-market compare-at** — a sale advertised in one currency/market but not another interacts with the
  per-currency ledger scope, so the compare-at is resolved per scope, not globally.

## Effort sketch

`1 capability` — a read-side compare-at resolution over the ledger's existing `priority` ordering and
closed-interval history, plus an optional explicit MSRP field for manufacturer prices. It is genuinely small
**because** the ledger already holds the regular and sale prices as ordered rows and keeps the history a
"was" claim needs, and the reduction machinery itself belongs to
[discounts-and-promotions.md](discounts-and-promotions.md) — this guide adds only the display-facing
reference price.
