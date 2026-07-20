---
title: Supplier and vendor
cluster: Product Catalog
effort: subsystem-scale (5+ capabilities)
attaches_to:
  - apps/catalog-microservice/src/modules/catalog/domain/product-variant.model.ts
  - apps/inventory-microservice/src/modules/stock/domain/stock-movement.model.ts
---

# Supplier and vendor

## Description

A supplier (or vendor) is a party the business **buys from**: the source of the goods it sells, with
its own contact identity, lead times, per-item cost, and — once purchasing is modelled — purchase
orders and goods-receipt documents. The universal core has no such party. It knows what a variant
*is* and how much stock of it sits in a location, but nothing about where that stock came from or
who to reorder it from. Saleor and Vendure keep suppliers out of their open cores for the same
reason; Adobe Commerce and NetSuite treat procurement as its own subsystem.

This guide **owns the Supplier / Vendor party**. Four other extensions build on the party defined
here and must not re-model it — consigned and vendor-managed inventory, dropshipping vendor routing,
marketplace seller payouts, and vendor RMAs. Each of those links back to this guide and inherits the
three decisions below: where the party lives, what keys it to sellable goods, and what it emits.

## Business needs

- A merchant that reorders stock needs a party to reorder *from*, with lead time and cost per item —
  the moment inventory replenishment stops being manual, a supplier record is unavoidable.
- Consignment and vendor-managed inventory need a party that **owns** stock the merchant holds but
  has not bought yet — a distinction the core's per-location running totals cannot express alone.
- A marketplace needs many selling parties behind one storefront, each owed a payout.
- The threshold: a single-source, buy-it-yourself shop never needs this; the first second supplier,
  or the first consignment agreement, is where the core stops being enough.

## Attachment points in the current core

- **`ProductVariant`, at `apps/catalog-microservice/src/modules/catalog/domain/product-variant.model.ts`.**
  The variant is the sellable, stocked, priced unit and the downstream backbone key — inventory,
  pricing and order lines all key on `variantId`, not on the product. A supply relationship attaches
  to sellable goods through that same `variantId`, exactly as the `price` ledger does, and like the
  ledger it treats `variantId` as an **opaque link** — the supplier context never imports the
  catalog `ProductVariant` (the opaque-link precedent, [ADR-025](../adr/025-catalog-product-and-variant-aggregate.md)).
- **`StockMovement`, at `apps/inventory-microservice/src/modules/stock/domain/stock-movement.model.ts`.**
  Its `referenceType` / `referenceId` pair is polymorphic and carries **no foreign key** — a movement
  can already point at any originating document by type and id. A goods-receipt against a purchase
  order becomes a `received` movement whose `referenceType` names the PO, with no schema change to the
  ledger.
- **A brand is not a supplier.** The [brand as a first-class entity](brand-entity.md) guide owns the
  marketing identity printed on the box; this guide owns the party the box was bought from. The same
  variant can carry one brand and be stocked from three suppliers.

## Implementation sketch

- **Where it lives: a new Procurement service, `apps/procurement-microservice/`.** A supplier that
  owns purchase orders, goods receipts and payment terms is a bounded context with its own aggregates
  and lifecycle — a different weight class from a `supplier` lookup column hung off a variant. Under
  [ADR-018](../adr/018-nestjs-monorepo-apps-and-libs.md) a new service is `apps/<name>/`, and under
  [ADR-042](../adr/042-one-bounded-context-one-module.md) that one bounded context is one module, a
  per-module hexagon whose Nest module file is its composition root
  ([ADR-041](../adr/041-nest-module-as-the-module-composition-root.md)). A column on
  `product_variant` is rejected precisely because it cannot grow the PO and receipt aggregates the
  four dependents need.
- **Aggregates:** `Supplier` (the party — its own PK, contact fields, payment terms), a `SupplyItem`
  relationship keyed on `(supplierId, variantId)` carrying lead time and cost, and — the reason it is
  a context, not a table — `PurchaseOrder` (owns its lines) and its goods-receipt record.
- **Keying:** the `SupplyItem` rides `variantId`; that is what ties procurement to sellable goods
  without coupling the two domains.
- **Events:** dotted `<service>.<aggregate>.<action>` on the existing `ris.events` topic exchange
  ([ADR-035](../adr/035-event-store-firehose-topic-exchange.md)) — `procurement.supplier.registered`,
  `procurement.purchase-order.placed`, `procurement.purchase-order.received`. The firehose captures
  them with no new binding, and a goods receipt drives an inventory `received` movement whose
  `referenceType` is the PO.
- **Shared types:** cross-service party views under `libs/contracts/<cluster>/`
  ([ADR-005](../adr/005-split-shared-common-into-bounded-libs.md)), never duplicated per service.

## Open design questions

- **Does a supplier own stock, or only supply it?** Consignment says the party can own stock the
  merchant physically holds — that pushes ownership into the stock model and is the seam the
  consigned-inventory guide reopens. Draw the line here: this guide defines the *party*; whether the
  party *owns* on-hand stock is deferred to that guide.
- **Is `variantId` enough, or does procurement need its own catalog of purchasable items?** A
  supplier may sell in cases while the merchant stocks eaches — a unit-of-measure conversion the flat
  `variantId` link does not carry.
- **One party type or two?** "Supplier" (buy from) and "vendor/seller" (sells through the
  marketplace) may be one party with two roles or two aggregates; the payout and RMA dependents pull
  in opposite directions on this.

## Effort sketch

`subsystem-scale (5+ capabilities)` — a new deployable with three or more aggregates (party, supply
item, purchase order, receipt), its own persistence and events, plus the inventory and payout seams
its dependents hang off. It anchors four downstream guides, so its shape is load-bearing rather than
local.
