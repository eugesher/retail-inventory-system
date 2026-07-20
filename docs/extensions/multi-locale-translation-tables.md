---
title: Multi-locale translation tables
cluster: Product Catalog
effort: 2–3 capabilities
attaches_to:
  - apps/catalog-microservice/src/modules/catalog/domain/product.model.ts
  - apps/catalog-microservice/src/modules/catalog/domain/category.model.ts
  - apps/notification-microservice/src/modules/notifications/
  - libs/cache/cache-keys.ts
---

# Multi-locale translation tables

## Description

Multi-locale support lets one catalog serve many languages: a product name, description and category
label each have a per-locale translation, resolved to the shopper's locale at read time. The core is
single-language — `Product.name`, `Product.description` and `Category.name` hold one string each. This
is the model Saleor and commercetools use: translatable fields backed by per-locale rows, with a
fallback chain when a translation is missing. Notably, the seam for a locale already exists downstream,
so this is an extension of a half-built axis, not a greenfield one.

## Business needs

- Any retailer selling across language borders — the EU and Switzerland make it non-optional.
- Even single-country shops with multiple official languages (Canada, Belgium) need it.
- The threshold: a single-language market never needs this; the first second language is where every
  customer-facing string must become locale-aware at once.

## Attachment points in the current core

- **`Product` and `Category`, at
  `apps/catalog-microservice/src/modules/catalog/domain/product.model.ts` and `category.model.ts`.**
  These own the translatable strings — product name/description, category name. Translations attach as
  per-locale sidecar rows keyed on `(entityId, locale)`, leaving the base row as the default-locale
  fallback.
- **The notification render path, at `apps/notification-microservice/src/modules/notifications/`.**
  The locale seam is **already present downstream**: every notification producer ships
  `customerLocale: null` on its dispatch events today — the order and returns use cases
  (`ship-fulfillment`, `issue-refund`, `mark-delivered`, `cancel-order`, the return flows) all send it
  as a deliberately-deferred field. Resolving a real locale here is filling that seam, not cutting a
  new one.
- **The template cache builders, at `libs/cache/cache-keys.ts`.** `notificationsTemplate` already keys
  on `(eventType, channel, locale)` — the locale axis is built into the key, and its prefix stops one
  segment short of the locale so one `delByPrefix` wipes every locale under a channel. A translated
  template read needs no new key shape.

## Implementation sketch

- **Catalog:** per-locale translation rows for the translatable fields — a `product_translation`
  keyed on `(productId, locale)` and a `category_translation` on `(categoryId, locale)`. The base
  row's string is the default-locale value and the fallback.
- **Resolution:** reads take a locale and fall back down a chain (requested → language → default). A
  cached translated read names a `CACHE_KEYS` builder with its version segment
  ([ADR-016](../adr/016-cache-aside-generalized.md),
  [ADR-022](../adr/022-cache-keys-tenant-and-schema-version.md)).
- **Notifications:** fill the `customerLocale` the producers already carry — resolve it once at the
  producing use case, and let the render path pick the locale-keyed template that already exists.
- **Shared types:** a locale enum and translated views under `libs/contracts/catalog/`
  ([ADR-005](../adr/005-split-shared-common-into-bounded-libs.md)); no PII rides the translation rows
  ([ADR-037](../adr/037-consent-record-and-tombstone-erasure.md)).

## Open design questions

- **Sidecar tables or JSON-per-field?** Per-locale rows join cleanly and index per language; a JSON
  map on the base row reads as one blob but pushes fallback logic into application code.
- **Who resolves the locale?** The gateway (from an `Accept-Language` header or customer profile), or
  each read model? The notification `customerLocale` field implies a producer-resolved locale, which
  argues for resolving once at the edge.
- **How deep does translation go?** Names and descriptions are obvious; slugs, media alt text, and
  typed attribute values are each a further step, and slugs collide with the URL layer.

## Effort sketch

`2–3 capabilities` — a catalog capability (translation rows and fallback resolution), a notification
capability (resolving the already-shipped `customerLocale` and selecting the locale-keyed template),
and a read capability for the storefront. The downstream locale seam already existing is what keeps it
below subsystem scale.
