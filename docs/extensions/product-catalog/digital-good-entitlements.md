---
title: Digital goods and entitlements
cluster: Product Catalog
effort: 2–3 capabilities
attaches_to:
  - apps/catalog-microservice/src/modules/catalog/domain/product-variant.model.ts
  - apps/retail-microservice/src/modules/orders/domain/fulfillment.model.ts
  - apps/notification-microservice/src/modules/notifications/
---

# Digital goods and entitlements

## Description

A digital good is a variant with no physical shipment: a licence key, a download, a subscription seat,
an event ticket. Buying it grants an **entitlement** — a durable right the customer holds — rather
than moving a box. The core assumes every sellable variant is stocked and shipped: fulfilment is
per-`stockLocationId`, and shipping captures payment. Digital goods break both assumptions and need a
shipment-less path. Shopify (digital downloads), Gumroad and the app stores are entitlement-first
systems; a universal retail core is not.

## Business needs

- Software, media, e-books, and course sellers deliver a right, not a parcel.
- Gift cards and event tickets are entitlements with their own redemption lifecycle.
- Mixed carts (a T-shirt plus its design file) need one order to fulfil two ways.
- The threshold: a physical-only catalog needs nothing here; the first non-shippable SKU is where
  fulfilment and payment-on-ship stop fitting.

## Attachment points in the current core

- **`ProductVariant`, at `apps/catalog-microservice/src/modules/catalog/domain/product-variant.model.ts`.**
  A variant needs a *kind* — physical versus digital — because that flag decides whether it is
  stocked, reserved, and shipped at all. Today every variant is implicitly physical.
- **`Fulfillment`, at `apps/retail-microservice/src/modules/orders/domain/fulfillment.model.ts`.**
  This is the load-bearing seam. `Fulfillment` requires a `stockLocationId`, and its `ship` mutator
  requires a tracking number and **captures payment before it ships**. A digital fulfilment has no
  location, no tracking, no carrier — it needs a distinct shipment-less path that still triggers the
  capture, or a `Fulfillment` whose location and tracking are nullable for the digital kind.
- **Notification delivery, at `apps/notification-microservice/src/modules/notifications/`.** The
  entitlement reaches the customer through the existing render-and-dispatch pipeline — the download
  link or key is the message body, sent on a `retail.entitlement.granted` event the notification
  service already knows how to consume-and-render.

## Implementation sketch

- **Catalog:** a `kind` on the variant (physical / digital). Digital variants skip stock
  initialisation entirely — there is no no-oversell for an infinitely-copyable good.
- **Orders:** a shipment-less fulfilment path. The cleanest shape is a digital fulfilment that never
  touches inventory, sets no tracking, and fires the capture the physical ship path fires — so payment
  timing stays consistent — then records the entitlement.
- **Entitlement:** a new aggregate (`Entitlement`: customer, variant, grant time, optional expiry,
  revoked flag) — arguably in `orders/` as a sibling of `Fulfillment`, or its own small context.
- **Delivery:** `retail.entitlement.granted` on `ris.events`
  ([ADR-035](../../adr/035-event-store-firehose-topic-exchange.md)); the notification consumer renders it
  through the existing pipeline. No PII in the payload — the key/link is a reference the notifier
  resolves ([ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md)).

## Open design questions

- **Does a digital variant reserve stock at all?** The clean answer is no — but a *seat-limited*
  digital good (100 tickets) does need a count, which looks like stock again. Whether limited digital
  goods reuse the stock model or get their own cap is unresolved.
- **Entitlement as a `Fulfillment` subtype or its own aggregate?** Reusing `Fulfillment` keeps one
  order-completion path; a separate aggregate keeps the shipment logic clean but forks the order's
  fulfilment roll-up.
- **Revocation on refund.** A physical return restocks; a digital refund must *revoke* the
  entitlement (deactivate the key, kill the download). That reverse path has no core analogue.

## Effort sketch

`2–3 capabilities` — a catalog capability (variant kind), an order capability (shipment-less
fulfilment plus the entitlement record), and a delivery capability riding the existing notification
pipeline. It touches three services but the notification leg is reuse, not new build.
