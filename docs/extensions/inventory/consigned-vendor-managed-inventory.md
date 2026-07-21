---
title: Consigned and vendor-managed inventory
cluster: Inventory
effort: 2–3 capabilities
attaches_to:
  - apps/inventory-microservice/src/modules/stock/domain/stock-level.model.ts
  - apps/inventory-microservice/src/modules/stock/domain/stock-movement.model.ts
---

# Consigned and vendor-managed inventory

## Description

In consignment, the merchant physically holds stock it **does not yet own** — title stays with the
supplier until the unit sells, and only then does the merchant owe for it. In vendor-managed inventory
(VMI), the supplier watches the merchant's stock levels and decides replenishment. Both break an
assumption baked into the core: that on-hand stock is the merchant's to sell freely and account for
plainly. The core's `StockLevel` has counters but **no owner** — a unit on hand is a unit on hand,
full stop.

This guide adds an **ownership axis** to stock. It does **not** re-model the supplier: the
[supplier and vendor](../product-catalog/supplier-and-vendor.md) guide owns that party, and this guide resolves the one
seam that guide explicitly deferred to it — *whether a supplier owns on-hand stock*. The answer, for
consignment, is yes.

## Business needs

- **Consignment retail** (art galleries, boutiques, bookstores, marketplaces with held stock) sells
  goods it has not purchased and settles with the owner on sale.
- **VMI supply relationships** (grocery, automotive parts) hand replenishment decisions to the
  supplier, who needs read access to stock and the ability to initiate purchase orders.
- **Accurate liability** — consigned stock must not appear as an owned asset, and its sale must create
  a payable to the owner.
- The threshold: a merchant that buys everything it sells never needs this; the first consignment
  agreement or VMI partner does.

## Attachment points in the current core

- **`StockLevel`, at `apps/inventory-microservice/src/modules/stock/domain/stock-level.model.ts`.**
  Ownership is a **new axis on a total that has none** — the counters and the `available` getter carry
  no notion of who owns the units. This is the model this guide extends.
- **`StockMovement`, at `apps/inventory-microservice/src/modules/stock/domain/stock-movement.model.ts`.**
  A consigned receipt is still a `receipt` movement; its polymorphic `referenceType` / `referenceId`
  (which carry no FK) can name the consignment agreement, so the ledger records provenance without a
  schema change to the movement's sign rule.
- **The `Supplier` party — defined in [supplier and vendor](../product-catalog/supplier-and-vendor.md), not here.** That
  guide places the party in a **new Procurement service, `apps/procurement-microservice/`**, keyed to
  sellable goods by a `(supplierId, variantId)` `SupplyItem` that treats `variantId` as an opaque link
  (procurement never imports the catalog `ProductVariant`). This guide consumes that identity and
  re-models none of it.

## Implementation sketch

- **Add an ownership dimension to the level.** The counters move from `(variantId, stockLocationId)` to
  `(variantId, stockLocationId, ownerId)`, where `ownerId` is null for merchant-owned stock or a
  `supplierId` for consigned stock. `available` stays a **derived getter**, now computed per
  owner-partition; the sellable total a storefront reads is the sum across owners (consigned stock **is**
  sellable — that is the whole point). The no-oversell guard holds within each partition and in
  aggregate.
- **Title transfers at commit-sale.** Selling a consigned unit is the moment ownership moves from
  supplier to customer and a **payable to the supplier** is created. That settlement is a procurement
  concern: the sale emits on `ris.events` (a `procurement.consignment.sold`-style event the procurement
  service consumes) — inventory records the stock fact, procurement records the money owed. No PII on
  the bus ([ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md)).
- **VMI is a read grant plus supplier-initiated replenishment.** The supplier reads stock levels
  (through a scoped query, not direct DB access) and initiates a `PurchaseOrder` on the procurement
  side; the goods-receipt flows back as a `received` movement exactly as an ordinary receipt does.
- **Events and types** ride the existing rails — dotted keys on `ris.events`, shared ownership-aware
  stock views under `libs/contracts/inventory/`.

## Open design questions

- **Ownership on the level, or a parallel ledger?** Splitting `StockLevel` by owner keeps availability
  in one place but complicates every counter operation; a separate consignment ledger keeps the core
  level clean but must reconcile against it. The choice mirrors the lot-axis decision in
  [lot, batch and serial tracking](lot-batch-serial-tracking.md).
- **When exactly does title transfer** — at sale (classic consignment), at receipt (VMI with immediate
  purchase), or at a period boundary (pay-by-scan)? Each changes when the payable is created.
- **Does consigned stock reserve differently?** A cart hold on a consigned unit is still a hold, but
  the no-oversell guard now runs per owner-partition — a hold that fits the variant total but exhausts
  one owner's partition is a new failure mode.
- **Mixed-owner allocation policy.** When both merchant-owned and consigned units of a variant sit in
  one location, which sells first? Selling consigned first defers the merchant's own cash outlay;
  selling owned first minimises payables. A policy call, akin to lot rotation.

## Effort sketch

`2–3 capabilities` — the ownership axis on the level, the title-transfer-and-payable seam at
commit-sale, and the VMI read/replenishment grant. It inherits the supplier party wholesale from
[supplier and vendor](../product-catalog/supplier-and-vendor.md), which is what keeps it from being subsystem-scale on its
own.
