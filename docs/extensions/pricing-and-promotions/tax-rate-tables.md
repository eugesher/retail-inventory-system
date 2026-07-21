---
title: Tax rate tables and jurisdictions
cluster: Pricing & Promotions
effort: 2–3 capabilities
attaches_to:
  - apps/catalog-microservice/src/modules/pricing/domain/tax-category.model.ts
---

# Tax rate tables and jurisdictions

## Description

**Tax rate tables** are the shop's *own* answer to "what rate applies here" — a maintained matrix of
`(jurisdiction × tax category) → rate` that computes tax internally, without a third-party engine. It is
the alternative to a call-out provider: a shop selling into a handful of stable jurisdictions can maintain
its own VAT and sales-tax rates far more cheaply than integrating Avalara or TaxJar. commercetools' tax
categories with per-country rates, and Adobe Commerce's tax-rate/tax-rule tables, are exactly this shape.

This guide **owns the rate data** — the jurisdictions, the rates, and how a variant's tax category resolves
to a number. It does **not** own the call-out seam or the storage: those belong to
[tax-computation-engine.md](../order-management/tax-computation-engine.md) (Order Management), which already defines the
`TAX_ENGINE` port and the place-time capture into the `taxAmountMinor` / `taxTotalMinor` fields. This guide
is the **internal-adapter alternative** that plugs rate tables into that same port — the engine guide's own
words: "a later pricing-side tax-rate-tables guide is the *alternative* implementation … it inherits the
port and the storage decision made here." Both fill the same core gap the root `README.md` records under
[`Not built yet`](../../../README.md#14-not-built-yet): *"Tax rates and jurisdictions — `TaxCategory` is a
label only."*

## Business needs

- **Simple, stable jurisdictions** — a shop selling within one country, or a small fixed set, can maintain
  a rate table by hand cheaper than paying for and integrating an external engine.
- **Data sovereignty and offline computation** — some businesses require tax computed in-house, without a
  call-out to a third party, for audit or regulatory reasons.
- **Category-differentiated rates** — food, books and children's clothing are taxed differently from
  general goods in many jurisdictions; the rate is a function of *both* where and *what*, which is exactly
  the `(jurisdiction × tax category)` cell.
- The threshold: a single-rate shop hard-codes one number; the first category-differentiated or
  multi-region rate — but *below* the volume that justifies a paid engine — is where an internal rate table
  earns its place.

## Attachment points in the current core

- **The `TaxCategory` label at
  `apps/catalog-microservice/src/modules/pricing/domain/tax-category.model.ts`.** This is the input the rate
  table keys on. `TaxCategory` carries a `code` and a `name` and — per its own comment and ADR-026 §6 — **no
  rate and no jurisdiction**; "the system computes no tax anywhere." A variant points at one category via
  the nullable `product_variant.tax_category_id` FK. The rate table supplies the missing half: it maps
  `(category code, jurisdiction) → rate`, leaving the label untouched. **This guide never adds a rate to
  `TaxCategory`** — that would re-introduce the coupling the label was designed to avoid.
- **The `TAX_ENGINE` port** ([tax-computation-engine.md](../order-management/tax-computation-engine.md)) — the seam this guide
  supplies an adapter for. An internal-rate-table adapter satisfies the same `quote(request) → per-line tax`
  interface the external providers do; the place-order flow calls it identically. This guide provides the
  rate *data and lookup* behind that adapter, nothing about the call-out point or the storage.
- **The `Not built yet` ledger row** in the root `README.md` — *"Tax rates and jurisdictions — `TaxCategory`
  is a label only."* Both this guide (the rate data) and the engine guide (the call-out) point at that one
  row; neither restates the other, per the three-places-record-the-unbuilt rule (ADR-055).

## Implementation sketch

- **A jurisdiction and rate model.** A `TaxJurisdiction` (a region — country, state, postal zone, or a tree
  of them) and a `TaxRate` row keyed to `(jurisdiction, taxCategory code)` carrying the rate and its
  effective window. Rates change over time, so a rate row is **effective-dated** the way a `Price` interval
  is — a rate change is a new row, not an edit, so a historical order's tax is reconstructable. This reuses
  the append-only-for-history discipline the price ledger already establishes.
- **The lookup behind the `TAX_ENGINE` adapter.** The internal adapter resolves the destination address to a
  jurisdiction, reads each line's variant → `tax_category_id` → category code, looks up the
  `(jurisdiction, code)` rate effective at place-time, and returns per-line tax to the engine's existing
  call-out point. The adapter is transport-free and unit-testable, like the pricing module's other seams.
- **Effective-dated rates, captured at place.** The rate in force at placement is applied and the resulting
  `taxAmountMinor` is frozen — the storage decision is the engine guide's, unchanged. A later rate change
  cannot alter a placed order, because the amount, not the rate, is what the order holds.
- **Events ride `ris.events`** — rate-table *maintenance* (a rate added or changed) may emit
  `catalog.tax-rate.changed` for audit; the tax *computation* itself rides inside `retail.order.placed`
  totals, adding nothing new. **No PII** (ADR-037): a jurisdiction is derived from an address, but the
  address never enters an event.
- **Shared types** (the rate view, the jurisdiction) under `libs/contracts/<cluster>/`.

## Open design questions

- **Jurisdiction resolution granularity** — country is easy; US sales tax is per-state-plus-local and can
  need postal-code-level rooftop accuracy, which is precisely where shops give up and buy an engine. How
  fine the internal table goes before an external provider is the better answer is the core scoping call.
- **Rate change management** — rates change by legislation on future dates; the table needs an effective-date
  model and a maintenance path, and a way to be sure a rate was current at a historical placement.
- **Tax-inclusive vs. tax-exclusive** — the same VAT-inclusive vs. US-exclusive question the engine guide
  raises, here decided by how the rate is applied to the ledger price.
- **Compound and bracketed taxes** — some jurisdictions stack taxes (a tax on a tax) or bracket them; a flat
  `(jurisdiction, category) → rate` cell may not be enough, and how much of that complexity to model
  internally versus defer to an engine is open.
- **When to switch to an engine** — the table and the external engine share the `TAX_ENGINE` port, so the
  migration is an adapter swap; but deciding the threshold, and running both during a cutover, is an
  operational question.

## Effort sketch

`2–3 capabilities` — the jurisdiction and effective-dated rate model, the internal `TAX_ENGINE` adapter that
resolves address + tax category to a rate, and the rate-maintenance path. It is bounded **because** it
inherits the call-out seam and the captured-not-computed storage from
[tax-computation-engine.md](../order-management/tax-computation-engine.md) and only supplies the rate data behind the existing
port — the money model does not change.
