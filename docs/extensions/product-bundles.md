---
title: Product bundles and kits
cluster: Product Catalog
effort: 2–3 capabilities
attaches_to:
  - apps/catalog-microservice/src/modules/catalog/domain/product.model.ts
  - apps/catalog-microservice/src/modules/catalog/domain/product-variant.model.ts
  - apps/retail-microservice/src/modules/cart/
  - apps/inventory-microservice/src/modules/stock/
---

# Product bundles and kits

## Description

A bundle is a single sellable thing whose contents are other variants: a "starter kit" that is really
three SKUs sold together, or a gift set priced below the sum of its parts. There are two shapes and
they behave differently. A **static kit** is one stock-keeping unit with a fixed bill of materials —
sold, picked and shipped as a unit. A **dynamic bundle** stays a set of component lines that are
priced together but reserved and fulfilled independently. Saleor and commercetools both make the
merchant choose between these two, because availability and fulfilment diverge from the choice.

## Business needs

- Any merchant running "buy the set" promotions, gift sets, or hardware-plus-consumable kits.
- Subscription boxes and meal kits are bundles by nature — a fixed set shipped as one.
- The threshold: a catalog of independent SKUs never needs this; the first offer that sells two SKUs
  as one priced unit is where the core stops being enough, because a cart line and a stock reservation
  both assume one `variantId`.

## Attachment points in the current core

- **The `Product` aggregate and its `ProductVariant` children, at
  `apps/catalog-microservice/src/modules/catalog/domain/product.model.ts` and
  `product-variant.model.ts`.** A bundle is authored as a product; its components are a new
  relationship — a `bundle_component` join keyed on `(bundleVariantId, componentVariantId, quantity)`
  — hanging off the catalog side, since the variant is the backbone key everything downstream shares.
- **The cart, at `apps/retail-microservice/src/modules/cart/`.** `CartLine` snapshots
  `unitPriceSnapshotMinor` / `currencySnapshot` at add-time and holds them stable while sibling lines
  change. A bundle forces a choice: keep the bundle as one line with one snapshot, or explode it into
  component lines at add-time. The snapshot convention is what makes the explosion decision matter —
  a bundle price is not the sum of component snapshots.
- **Stock, at `apps/inventory-microservice/src/modules/stock/`.** A bundle's availability is the
  minimum over its components' available quantities per location; the no-oversell reservation path
  keys on `variantId` per `(variant, location)`, so a bundle either reserves each component or is not
  a stocked unit at all.

## Implementation sketch

- **Catalog:** add a bundle relationship (the `bundle_component` join) and mark a variant as a bundle
  head. No new bounded context — bundles are a catalog concern, a sibling of the existing aggregates
  in the same module ([ADR-025](../adr/025-catalog-product-and-variant-aggregate.md)).
- **Availability:** a read that composes component stock into a bundle-available number, reusing the
  `variantId`-keyed stock reads rather than storing a second running total (which would drift).
- **Events:** `catalog.bundle.defined` on `ris.events`
  ([ADR-008](../adr/008-rabbitmq-via-libs-messaging.md),
  [ADR-035](../adr/035-event-store-firehose-topic-exchange.md)); component reservations remain the
  existing inventory events, one per component.
- **Cache:** a composed availability read names a `CACHE_KEYS` builder with its version segment, no
  key literal in `apps/` ([ADR-016](../adr/016-cache-aside-generalized.md)).

## Open design questions

- **Explode at add-to-cart, at place-order, or never?** Exploding early makes each component a normal
  line (simple pricing, simple fulfilment) but loses the bundle's identity on the order; exploding
  late keeps the bundle whole but forces bundle-aware reservation and refund logic.
- **Does a bundle carry its own `Price` row, or is its price computed from components?** A stored
  bundle price can undercut the component sum (the whole point of a kit) but must be maintained; a
  computed price cannot express a discount.
- **Partial availability.** If two of three components are in stock, is the bundle unavailable, or
  backorderable? The answer decides whether a bundle can even be reserved.

## Effort sketch

`2–3 capabilities` — a catalog composition capability (define the bundle and its components), a cart
capability (the explode-or-hold decision and its pricing), and an inventory read capability (composed
availability). It spans three services but adds no new bounded context.
