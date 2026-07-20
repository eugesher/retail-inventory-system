---
title: Configurable products and option dependencies
cluster: Product Catalog
effort: 2–3 capabilities
attaches_to:
  - apps/catalog-microservice/src/modules/catalog/domain/product-variant.model.ts
  - apps/retail-microservice/src/modules/cart/
---

# Configurable products and option dependencies

## Description

A configurable product is one a customer *assembles* from options, where the options constrain each
other: a laptop where 16GB RAM is only offered with the discrete GPU, or a shirt where "monogram"
unlocks a text field. The core models the *result* — each buyable combination is a `ProductVariant`
with a flat `optionValues` map — but not the *rules* that say which combinations are legal. Adobe
Commerce's configurable products and Shopify's option sets both add exactly this: a dependency layer
above the variant axis.

## Business needs

- Apparel with size/colour matrices where not every pair exists.
- Configure-to-order goods (electronics, furniture, bikes) where options gate other options.
- Personalisation (engraving, monogram) where picking one option reveals a required input.
- The threshold: a catalog where every option combination is valid needs nothing here; the first
  "this colour only in these sizes" rule is where a flat variant list stops being enough.

## Attachment points in the current core

- **The variant axis, at `apps/catalog-microservice/src/modules/catalog/domain/product-variant.model.ts`.**
  `optionValues` (the `OptionValues` VO) is the flat map of axis → value. It has no notion of one
  axis depending on another; dependency rules attach above it, either as catalog metadata or as a
  separate rule set.
- **The add-to-cart path, at `apps/retail-microservice/src/modules/cart/`.** A configured selection
  becomes a `CartLine` for a concrete `variantId`. If invalid combinations are even representable,
  the add path is the last gate that can reject one before it becomes an order line.

## Implementation sketch

- **Two honest shapes.** Either pre-generate a `ProductVariant` for every *legal* combination (the
  core already supports this — an illegal pair simply has no variant), or keep options and evaluate
  dependency rules at selection time. The first needs no new domain but explodes the variant count;
  the second needs a rule model but keeps the catalog small.
- **If rules are modelled:** an `OptionDependency` set (option A value ⇒ option B constrained), a
  catalog concern in the same module ([ADR-025](../adr/025-catalog-product-and-variant-aggregate.md)),
  evaluated when a selection resolves to a variant.
- **Cart-side enforcement:** the add-to-cart use case rejects a selection that resolves to no variant
  or violates a rule, surfacing a domain error rather than a raw 500.
- **Events:** if rules become catalog data, `catalog.option-rule.defined` on `ris.events`
  ([ADR-035](../adr/035-event-store-firehose-topic-exchange.md)); the buyable result stays the
  existing `catalog.variant.created`.

## Open design questions

- **Pre-generated variants or runtime rules?** This is the whole design fork. Pre-generation reuses
  the entire existing stack (stock, price, cart all key on the concrete `variantId`) at the cost of a
  combinatorial variant table; runtime rules keep the table small but add a resolver every buying path
  must call.
- **Where does the rule live and run?** In catalog at variant-create time (rules shape which variants
  exist), or in the cart at add time (rules validate a live selection)? The answer decides which
  service owns the rule model.
- **Custom-input options** (engraving text) are not axes at all — they produce a per-line attribute,
  not a variant, and need somewhere on the `CartLine`/`OrderLine` to live.

## Effort sketch

`2–3 capabilities` — a catalog capability for the option/dependency model and a cart capability for
selection validation, plus a read capability if the storefront renders the option tree. It leans on
the existing variant axis rather than replacing it, which is what keeps it out of subsystem scale.
