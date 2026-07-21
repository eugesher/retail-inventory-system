---
title: Dropshipping and vendor routing
cluster: Order Management
effort: 2–3 capabilities
attaches_to:
  - apps/retail-microservice/src/modules/orders/domain/fulfillment.model.ts
  - apps/retail-microservice/src/modules/orders/domain/fulfillment-line.model.ts
---

# Dropshipping and vendor routing

## Description

Dropshipping is fulfilment the shop never touches: instead of picking from its own stock, the order is
routed to a vendor who ships directly to the buyer. The shop still owns the order, the payment and the
customer relationship — only the physical shipment moves to the vendor. Shopify (via vendor apps),
commercetools and most marketplace platforms model this as a fulfilment that resolves to an external
supplier rather than an internal warehouse.

This guide builds on the [supplier / vendor party](supplier-and-vendor.md), which already lives in a
Procurement bounded context and keys to sellable goods by `variantId`. It does **not** re-model the
party; it decides how a `Fulfillment` gets *routed* to that vendor and how the vendor's shipment
reports back.

## Business needs

- **Long-tail catalogs** — a shop lists goods it never stocks, holding no inventory risk; the vendor
  ships on demand.
- **Oversized or hazmat goods** that are uneconomic to warehouse ship best straight from the maker.
- **Mixed baskets** — one order with some own-stock lines and some dropship lines — need per-line
  routing, so the split is at the fulfilment, not the order.
- The threshold: a shop that ships everything from its own `StockLocation`s never needs this; the first
  supplier-shipped SKU is where routing has to become a decision.

## Attachment points in the current core

- **The `Fulfillment` aggregate at
  `apps/retail-microservice/src/modules/orders/domain/fulfillment.model.ts`.** A fulfilment is already
  **per-`stockLocationId`** and per-shipment — an order with split shipments owns several. Crucially,
  `StockLocation` already supports a **virtual, non-physical** location (its type enum carries
  `dropship-virtual`), so a dropship fulfilment routes to a vendor-backed virtual location rather than a
  warehouse. The routing seam already has a precedent.
- **`FulfillmentLine` at
  `apps/retail-microservice/src/modules/orders/domain/fulfillment-line.model.ts`** — routing is
  per-line-group, so a mixed basket splits into an own-stock fulfilment and a dropship fulfilment, each
  with its own lines.
- **The supplier party** in the [supplier / vendor guide](supplier-and-vendor.md) — the vendor that
  receives the routed shipment is the `Supplier` already defined there, and the `(supplierId, variantId)`
  supply relationship is what says which vendor can ship which SKU.

## Implementation sketch

- **A dropship fulfilment is an ordinary `Fulfillment`** pinned to a vendor-backed virtual
  `StockLocation`. Its `ship` transition and tracking-on-ship policy are unchanged — the difference is
  who performs the shipment, not the state machine.
- **Routing decides the vendor at fulfilment-planning time.** The Create Fulfillment use case, given a
  dropship line, resolves the vendor from the supply relationship and creates the fulfilment against
  that vendor's virtual location. A `RoutingPolicy` port picks among vendors when more than one can ship
  a SKU (cheapest, fastest, in-region).
- **The vendor is notified over `ris.events`, not a new transport** — `retail.fulfillment.created` with
  a dropship destination is consumed by the Procurement context, which places the actual PO with the
  vendor. The vendor's ship confirmation arrives as an inbound event (or webhook ingested into one)
  that drives the existing `retail.fulfillment.ship` flow.
- **Suppress own-stock behaviours for the virtual location** — a dropship line holds no reservation
  against a warehouse and decrements no `StockLevel`, the way a `dropship-virtual` location is already
  treated specially. The commit-sale ledger movement either does not fire or fires against the virtual
  location.
- **Shared types** (the routing decision, the vendor-shipment inbound shape) under
  `libs/contracts/<cluster>/`.

## Open design questions

- **Does dropship stock participate in availability at all?** If the vendor is assumed to have
  unlimited stock, no `StockLevel` exists and no-oversell does not apply; if the vendor reports stock,
  it needs a feed — a much larger integration.
- **Who owns tracking?** The vendor's carrier and tracking number have to flow back onto the
  `Fulfillment`; the shape of that inbound (event, webhook, polled API) is unresolved.
- **Split-shipment cost and SLA** — a mixed basket may ship in two parcels from two origins; whether the
  buyer sees one delivery promise or two is a checkout-UX decision with order-model consequences.
- **Failed vendor fulfilment** — if the vendor cannot ship, the line has to re-route or cancel, which
  touches the active-quantity unwind (ADR-040) rather than a simple retry.

## Effort sketch

`2–3 capabilities` — vendor routing at fulfilment-planning, the vendor-backed virtual location, and the
inbound ship-confirmation wiring. It stays this size because it **reuses** the `Fulfillment` aggregate,
the `dropship-virtual` location precedent, and the supplier party rather than introducing any of them.
