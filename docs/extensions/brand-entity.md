---
title: Brand as a first-class entity
cluster: Product Catalog
effort: 1 capability
attaches_to:
  - apps/catalog-microservice/src/modules/catalog/domain/category.model.ts
  - apps/catalog-microservice/src/modules/catalog/domain/media-asset.model.ts
---

# Brand as a first-class entity

## Description

A brand is the manufacturer or label a product is sold under — Sony, Levi's, a private label. Shoppers
filter by it, brand pages collect it, and it prints on the box. The core has no brand: today a brand
could only be faked as a top-level node in the category tree or as a free-text attribute, and both
lose the thing that makes a brand a brand — a stable identity with a logo, spanning many categories at
once. commercetools and most PIMs model brand as its own small entity for exactly that reason.

## Business needs

- Brand-filtered browsing and brand landing pages — table stakes for any multi-brand retailer.
- Brand-level reporting ("how is Sony selling") that a category filter cannot give, because a brand
  cuts *across* categories.
- The threshold: a single-brand or own-label shop needs nothing here; the second brand is where a
  first-class brand entity starts paying off.

## Attachment points in the current core

- **`Category`, at `apps/catalog-microservice/src/modules/catalog/domain/category.model.ts`.** This is
  the tree a brand would *otherwise* be forced into — and the reason not to. A category is a
  materialized-path node in one hierarchy; a brand is an orthogonal facet that a product carries
  regardless of where it sits in the tree. Modelling brand as a category corrupts the "one product,
  one path" meaning of the tree.
- **`MediaAsset`, at `apps/catalog-microservice/src/modules/catalog/domain/media-asset.model.ts`.** A
  brand logo is a polymorphic media owner. `MediaAsset` already points at `(ownerType, ownerId)` with
  no foreign key, and `MediaOwnerTypeEnum` gains a `brand` member — the logo reuses the entire
  existing media path with no new storage.

## Implementation sketch

- **Aggregate: `Brand`** (id, name, slug, optional logo via `MediaAsset`) — a catalog write aggregate,
  a sibling of `Product` / `Category` / `MediaAsset` in the same module
  ([ADR-029](../adr/029-category-materialized-path-and-polymorphic-media.md)).
- **Link:** a nullable `brandId` on `Product` (a product has at most one brand). No change to the
  variant backbone.
- **Media:** extend `MediaOwnerTypeEnum` with `brand`; the logo attaches through the existing media
  attach path, no schema change to `media_asset`.
- **Events:** brand edits are low-stakes catalog data — a `catalog.brand.registered` event on
  `ris.events` ([ADR-035](../adr/035-event-store-firehose-topic-exchange.md)) is optional.
- **A brand is not a supplier.** The brand is the marketing identity on the product; the party the
  goods were *bought from* is a separate concern owned by the [supplier and vendor](supplier-and-vendor.md)
  guide. The same variant can carry one brand and be sourced from several suppliers.

## Open design questions

- **Own aggregate or category subtype?** A `Brand` aggregate is cleaner but adds an entity; a
  reserved-root category subtree ("/brands/…") reuses the tree at the cost of the corruption noted
  above. This guide argues for the aggregate.
- **One brand per product, or per variant?** Bundles and multi-vendor listings can mix brands within
  one product; a product-level `brandId` cannot express that.
- **Does brand belong to the product or the manufacturer party?** If a supplier context exists, brand
  and manufacturer risk overlapping — the guide keeps them separate but flags the seam.

## Effort sketch

`1 capability` — one small aggregate, a nullable FK on `Product`, and a new `MediaOwnerTypeEnum`
member that reuses the whole media path. No new lifecycle, no new service; the only real decision is
aggregate-versus-category, which is why it stays a single capability.
