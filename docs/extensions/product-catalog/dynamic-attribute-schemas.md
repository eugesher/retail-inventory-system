---
title: Dynamic typed attribute schemas
cluster: Product Catalog
effort: subsystem-scale (5+ capabilities)
attaches_to:
  - apps/catalog-microservice/src/modules/catalog/domain/product.model.ts
  - apps/catalog-microservice/src/modules/catalog/domain/product-variant.model.ts
  - libs/contracts/catalog/
---

# Dynamic typed attribute schemas

## Description

The core already carries per-variant option values as an untyped free-form map:
`optionValues: Record<string, string>`, held behind the `OptionValues` value object on
`ProductVariant`. That is enough to say *"this variant is size L, colour red"*, but not to say *"screen
size is a number in inches, in range 4–8"* or *"material is one of a fixed enum, and it is required
for this category"*. A dynamic attribute schema turns that flat string map into **typed, validated,
per-category attribute definitions** — the model Saleor, commercetools and Akeneo (a PIM) are built
around. It is the difference between a storefront that can facet-search on "battery capacity ≥
4000mAh" and one that can only match strings.

## Business needs

- Electronics, apparel and grocery each need different typed attributes (wattage, fabric, allergens),
  and a universal core cannot hard-code any of them.
- Faceted search and comparison tables need typed values — a number to range-filter on, an enum to
  group by — not free text.
- The threshold: a small catalog with a handful of consistent options lives fine on the string map;
  the first category that needs a required, validated, typed attribute is where the map breaks down.

## Attachment points in the current core

- **`ProductVariant`, at `apps/catalog-microservice/src/modules/catalog/domain/product-variant.model.ts`.**
  The `OptionValues` VO is the thing this replaces or wraps — it validates only that the map is
  non-empty, with no per-key typing. Typed attributes either live beside it or subsume it.
- **`Product`, at `apps/catalog-microservice/src/modules/catalog/domain/product.model.ts`.** Some
  attributes are product-level (brand-agnostic description facets), some variant-level (the buyable
  axes); the schema has to say which.
- **The view classes under `libs/contracts/catalog/`.** `product-variant.view.ts`,
  `product-with-variants.view.ts` and their siblings expose a fixed shape today. Typed dynamic
  attributes make the exposed shape *data-driven* — the hardest downstream consequence, because every
  consumer of these views assumes a static schema.

## Implementation sketch

- **Aggregate: `AttributeDefinition`** — a typed, per-category attribute (name, data type, required
  flag, allowed values / range). It is a catalog write aggregate, a sibling of the existing ones in
  the same module ([ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md)).
- **Storage:** either an EAV table of `(ownerType, ownerId, attributeId, value)` or a validated JSON
  column per product/variant. Both are viable; the choice drives everything about search.
- **Validation across aggregates.** A variant's values must validate against the category's
  definitions, but the `ProductVariant` aggregate cannot see the `AttributeDefinition` aggregate. This
  is the same shape as the publish-time price check, which the domain deliberately does *not* model
  and a use case enforces via a probe. Attribute validation follows that precedent — a use-case probe,
  not a domain invariant.
- **Shared types:** dynamic attribute views under `libs/contracts/catalog/`
  ([ADR-005](../../adr/005-split-shared-common-into-bounded-libs.md)); a cached typed-attribute read
  names a `CACHE_KEYS` builder ([ADR-016](../../adr/016-cache-aside-generalized.md)).

## Open design questions

- **EAV or JSON?** EAV facet-searches cleanly and validates per row but explodes join counts; a JSON
  column reads as one blob but pushes typing and search into application code or generated columns.
- **How does a static-typed view expose a dynamic schema?** The `libs/contracts/catalog/` views are
  compiled classes; a dynamic attribute set has no compile-time shape. A generic
  `attributes: AttributeValueView[]` bag is honest but loses type safety at the edge.
- **Inheritance down the category tree.** Does a child category inherit its parent's attribute
  definitions, and can it override them? The materialized-path tree makes inheritance cheap to read
  and expensive to invalidate.

## Effort sketch

`subsystem-scale (5+ capabilities)` — a new aggregate, a storage model that reshapes search, cross-
aggregate validation, a rewrite of the contract views, and the faceted-read path that justifies the
whole thing. Any one of those is a capability; together they are a subsystem, and the view rewrite
touches every catalog consumer.
