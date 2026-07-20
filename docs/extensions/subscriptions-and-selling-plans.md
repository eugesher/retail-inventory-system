---
title: Subscriptions and selling plans
cluster: Product Catalog
effort: subsystem-scale (5+ capabilities)
attaches_to:
  - apps/catalog-microservice/src/modules/catalog/domain/product-variant.model.ts
  - apps/catalog-microservice/src/modules/pricing/domain/price.model.ts
---

# Subscriptions and selling plans

## Description

A selling plan is the offer *"buy this variant on a recurring cadence"* — the thing a customer picks
at add-to-cart when a product can be bought once or subscribed to. It names which variants are
subscribable, the cadences on offer (weekly, monthly, every-90-days), and how the recurring price
relates to the one-off price. Shopify's Selling Plans and commercetools' recurring-order models draw
the same shape: a plan is catalog data; a subscription instance is order data.

This guide **owns the plan definition** and nothing that runs on a clock. The recurrence engine —
scheduled `Order` generation, the payment retry ladder, dunning — belongs to a separate guide in
order management, which links back here for the plan it charges against. The boundary is stated
explicitly in *Open design questions* so the engine guide can quote it rather than renegotiate it.

## Business needs

- Replenishables (coffee, razor blades, pet food, supplements) convert far better with a subscribe
  option than with a reminder email; the plan is the mechanism that offer needs.
- Membership and box businesses are subscription-first — the recurring plan *is* the product.
- The threshold: a shop selling only one-off purchases never needs a plan; the first "subscribe &
  save" offer is where the catalog must start describing cadence and recurring price.

## Attachment points in the current core

- **`ProductVariant`, at `apps/catalog-microservice/src/modules/catalog/domain/product-variant.model.ts`.**
  A plan is offered *for a variant* — the subscribable unit is the same `variantId` the rest of the
  platform keys on. A plan therefore attaches to the catalog side, alongside the variant, not to the
  cart or order.
- **The `Price` ledger, at `apps/catalog-microservice/src/modules/pricing/domain/price.model.ts`.**
  Price is an append-only-for-history ledger: a currency-scoped, time-bounded `[validFrom, validTo)`
  amount per `(variantId, currency)`, with a `priority` tiebreak
  ([ADR-026](../adr/026-price-append-only-ledger-and-tax-category.md)). A plan's recurring price is a
  *relationship to* that ledger — a discount off the resolved active price, or a plan-scoped ledger
  row that wins on `priority` — never an in-place edit of the one-off row.

## Implementation sketch

- **Aggregate: `SellingPlan`** in the catalog module — the offer definition. It carries the cadence
  options, an optional commitment (minimum cycles), and the price relationship. It references
  `variantId` opaquely, the same way `Price` does.
- **Price relationship, not price copy.** The plan states *how* to derive the recurring amount (e.g.
  "−15% off the active price at charge time"); it does not snapshot an amount. Resolving the amount is
  the engine's job at each charge, reading the ledger's active row for the `(variantId, currency)`
  scope as it stands then. This keeps the plan free of stale prices and keeps `Price` the single
  source of the number.
- **Events:** dotted `<service>.<aggregate>.<action>` on `ris.events`
  ([ADR-035](../adr/035-event-store-firehose-topic-exchange.md)) — `catalog.selling-plan.defined`,
  `catalog.selling-plan.retired`. No new transport, no new broker.
- **Shared types:** the plan view under `libs/contracts/<cluster>/`
  ([ADR-005](../adr/005-split-shared-common-into-bounded-libs.md)), so both the catalog producer and
  the recurrence engine read one shape.

## Open design questions

- **The boundary this guide draws, verbatim for the engine guide to quote:** *the plan (what can be
  subscribed to, on which cadences, at what price relationship to the one-off ledger row) lives here
  in the catalog; the engine (scheduled `Order` generation, the payment retry ladder, dunning, pause
  and skip) lives in order management.* Splitting it here is what keeps scheduling out of the catalog
  — the catalog never runs a clock, and a subscription instance is an order concern, not a product
  one.
- **Discount-off versus plan-scoped ledger row.** A percentage off the active price is simplest but
  cannot express "£9 for the first three boxes"; a plan-scoped `Price` row with its own `priority`
  can, at the cost of more ledger rows. Which the plan stores is unresolved.
- **Where cadence eligibility is enforced.** Not every variant should be subscribable — is that a
  flag on the plan, a category rule, or a curated allow-list?

## Effort sketch

`subsystem-scale (5+ capabilities)` for the whole subscription story, of which this guide is the
catalog-side share: the plan aggregate, its price relationship, its views and events. The heavier
half — the recurrence engine — is a separate guide, and the two together are why the effort reads
subsystem-scale rather than a single capability.
