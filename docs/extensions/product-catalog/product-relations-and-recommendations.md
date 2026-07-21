---
title: Product relations and recommendations
cluster: Product Catalog
effort: 1 capability
attaches_to:
  - apps/catalog-microservice/src/modules/catalog/domain/product.model.ts
  - libs/cache/cache-keys.ts
---

# Product relations and recommendations

## Description

Product relations are the curated links between products a storefront shows as "related", "frequently
bought together", "you may also like", or "upgrade to". The core has no notion of one product
pointing at another. This guide covers the *curated* half — a merchant-authored graph of typed
relations — and draws a line at the *computed* half, where a recommender infers relations from
behaviour, because that is a downstream analytics concern rather than a catalog one. Shopify's related
products and Adobe Commerce's related/up-sell/cross-sell slots are the curated shape.

## Business needs

- Cross-sell and up-sell merchandising — the single highest-leverage catalog feature after search.
- Accessory and compatibility links ("cases for this phone").
- The threshold: a catalog of standalone products can launch without this; the first "customers also
  bought" or "works with" slot is where a product needs to reference another product.

## Attachment points in the current core

- **The `Product` aggregate, at `apps/catalog-microservice/src/modules/catalog/domain/product.model.ts`.**
  A relation is a typed edge between two products — a `product_relation` join keyed on
  `(fromProductId, toProductId, relationType)`. It is a catalog concern, a sibling of the existing
  aggregates in the same module ([ADR-025](../../adr/025-catalog-product-and-variant-aggregate.md)).
- **The reserved `catalogProduct*` cache builders, at `libs/cache/cache-keys.ts`.**
  `catalogProductPrefix` / `catalogProduct` exist as reserved builders with no caller today. A related-
  set read is exactly the kind of cached catalog read they were kept for — it adopts the `v1` shape
  without re-keying, and invalidates via the prefix + `delByPrefix`
  ([ADR-016](../../adr/016-cache-aside-generalized.md),
  [ADR-022](../../adr/022-cache-keys-tenant-and-schema-version.md)).

## Implementation sketch

- **Aggregate/relationship:** the `product_relation` self-join above, with a small `relationType`
  enum (related / cross-sell / up-sell / accessory). No new bounded context; no new lifecycle — a
  relation is created and deleted, nothing more.
- **Read path:** "products related to X" is a single indexed read, cached under the reserved
  `catalogProduct*` builder.
- **Events:** relations are low-stakes catalog data; a `catalog.product.related` event on
  `ris.events` ([ADR-035](../../adr/035-event-store-firehose-topic-exchange.md)) is optional, mainly for
  cache invalidation in a future read service.
- **Shared types:** a related-products view under `libs/contracts/catalog/`
  ([ADR-005](../../adr/005-split-shared-common-into-bounded-libs.md)).

## Open design questions

- **Directed or symmetric?** "Accessory of" is directed; "related to" is usually symmetric. Storing
  one edge and reading both directions, versus storing both edges, changes the write path.
- **Where do *computed* recommendations live?** Behavioural recommendations ("customers who bought…")
  are derived from order history and belong to a read/analytics service, not the catalog write model.
  This guide deliberately owns only the curated graph; the computed layer is a separate concern that
  would consume catalog and order events rather than extend the `Product` aggregate.
- **Do relations point at products or variants?** A relation is usually product-to-product, but "buy
  the matching strap" is variant-specific — the key choice ripples into every read.

## Effort sketch

`1 capability` — a self-join, a curated write path, and one cached read that adopts an already-reserved
key builder. It adds no lifecycle and no new service, which is what keeps it to a single capability;
the computed-recommendation layer, explicitly out of scope, is where the real weight would be.
