---
title: Shipping rate engine
cluster: Order Management
effort: 2–3 capabilities
attaches_to:
  - apps/retail-microservice/src/modules/orders/domain/fulfillment.model.ts
  - apps/retail-microservice/src/modules/orders/domain/address.model.ts
---

# Shipping rate engine

## Description

A shipping rate engine turns *where it's going, how heavy it is, and how fast the buyer wants it* into a
price and a set of delivery options at checkout. Real-time carrier rates (via EasyPost, Shippo, or a
carrier's own API) or internal rate tables both answer the same question: what does this parcel cost to
ship, and which service levels are on offer. Every checkout that charges for shipping runs one.

Like tax, the core has the **storage seam waiting**: an order carries `shippingTotalMinor`, captured and
frozen at placement, currently always `0` because there is no shipping capability yet. This guide is what
computes that number and offers the buyer the choice behind it.

## Business needs

- **Physical goods with real carriers** — anything shipped by weight or zone needs a rate, and charging a
  flat fee over- or under-charges most orders.
- **Service-level choice** — buyers expect to pick economy vs. express and see the cost of each; that
  choice is an input to the order, not an afterthought.
- **Free-shipping thresholds and promotions** interact with the rate (free over £50), so the computed
  rate has to be adjustable by rules.
- The threshold: a digital-only shop never needs this; a shop that puts anything in a box reaches it as
  soon as shipping stops being a single flat fee.

## Attachment points in the current core

- **The `Fulfillment` aggregate at
  `apps/retail-microservice/src/modules/orders/domain/fulfillment.model.ts`.** A fulfilment is already
  **per-`stockLocationId`**, which is the shipment's *origin* — rating is origin-to-destination, so the
  fulfilment is where a rate is realised. A split shipment (two origins) rates twice, one per fulfilment.
- **The `Address` aggregate at
  `apps/retail-microservice/src/modules/orders/domain/address.model.ts`.** It is the **destination**:
  a polymorphic aggregate carrying `country` (validated 2-letter ISO), `region` and `postalCode` — exactly
  the fields a rate call needs. The shipping address snapshot taken at place-time is the rating input.
- **`Order.shippingTotalMinor`** (`order.model.ts`) — the storage seam: `0` today, summed into
  `grandTotalMinor` by the order's total invariant, frozen at placement. A real engine writes the chosen
  rate here.

## Implementation sketch

- **A `SHIPPING_RATE_ENGINE` port**, mirroring `PAYMENT_GATEWAY`: `rate(request) → options[]`, each
  option a service level and an amount. The bound adapter calls a carrier aggregator from
  `infrastructure/`; a default adapter returns a single flat or `0` rate so the seam exists before a
  provider is wired.
- **Rating happens at checkout**, against the destination `Address` and the basket's weight/dimensions
  (which implies a shippable-weight attribute on the catalog side — a genuine dependency, not a given).
  The buyer picks an option; the chosen amount is written to `shippingTotalMinor` and frozen when the
  order places.
- **Store the chosen rate, never re-rate a placed order** — the same immutability discipline as tax and
  price. Carrier rates fluctuate; the buyer's contract is the rate they accepted at checkout.
- **Free-shipping and promotion rules** adjust the rated amount before it is frozen — a rules layer over
  the engine, not inside it, so the engine stays a pure rate lookup.
- **Events** ride `ris.events` — the rate rides inside the existing `retail.order.placed` totals; no new
  transport. **No PII in the payload** (ADR-037): the destination drives the rate, but the address stays
  out of any event.
- **Shared types** (the rate request/options) under `libs/contracts/<cluster>/`.

## Open design questions

- **Where does shippable weight/dimensions live?** The catalog has no weight attribute today; rating needs
  one, which is a catalog extension the engine depends on (and dynamic-attribute-schemas would host).
- **Rate at cart vs. rate at place** — showing a shipping estimate in the cart means rating before the
  full address is known, then re-rating at place; what happens if they diverge is unresolved.
- **Split-shipment rating** — a mixed-origin order rates per fulfilment, but the buyer sees one shipping
  line; how per-fulfilment rates roll up into one `shippingTotalMinor` is a modelling call.
- **Label purchase and manifesting** — a full engine also *buys* the label and returns tracking, which
  overlaps the fulfilment ship flow and is a larger scope than pure rating.

## Effort sketch

`2–3 capabilities` — the rate-engine port and adapter, the checkout rating step writing into the existing
`shippingTotalMinor` seam, and the free-shipping rules layer. It stays this size because the storage seam
exists and rating reuses the destination `Address` snapshot; the weight-attribute dependency is the one
piece that reaches outside order management.
