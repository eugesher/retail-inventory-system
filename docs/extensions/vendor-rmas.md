---
title: Vendor RMAs
cluster: Returns & Refunds
effort: 2–3 capabilities
attaches_to:
  - apps/retail-microservice/src/modules/returns/domain/return-request.model.ts
  - apps/retail-microservice/src/modules/returns/application/ports/inventory-restock.gateway.port.ts
---

# Vendor RMAs

## Description

A **vendor RMA** is the *outbound* mirror of a customer return: when a returned or defective unit cannot
go back to sellable stock, the shop sends it **back to the supplier it bought the unit from** — for a
credit, a replacement, or a warranty repair. The customer-facing RMA the core already models walks goods
*in* from the buyer; a vendor RMA walks goods *out* to the party the [supplier-and-vendor.md](supplier-and-vendor.md)
guide owns. It reuses the same disposition vocabulary as its trigger — a line inspected `damaged` and
dispositioned to `quarantine` is precisely the unit that becomes a vendor return — and adds a supplier-side
lifecycle the buyer-side one does not have: a shipment out, a supplier acknowledgement, and a settlement
(credit note or replacement) coming back.

This guide **inherits the Supplier / Vendor party** from
[supplier-and-vendor.md](supplier-and-vendor.md) and does not re-model it — the party, its contact
identity and its keying to sellable goods are defined there; a vendor RMA is one of the capabilities that
guide names as building on it.

## Business needs

- **Defective-stock recovery** — a unit that arrives faulty or is returned unsellable is a loss unless
  the shop can claim against the supplier; a vendor RMA is how that claim is made and tracked.
- **Warranty pass-through** — a manufacturer warranty on the *shop's* purchase means the shop returns the
  unit upstream and passes the remedy on, rather than eating the cost.
- **Quarantine drain** — items dispositioned `quarantine` at customer-return inspection accumulate; a
  vendor RMA is the path that empties that holding state to a supplier instead of to scrap.
- The threshold: the first supplier relationship where returning defective stock for credit is worth more
  than scrapping it — i.e. as soon as suppliers are modelled at all
  ([supplier-and-vendor.md](supplier-and-vendor.md)) and defective units have non-trivial value.

## Attachment points in the current core

- **The `ReturnRequest` aggregate at
  `apps/retail-microservice/src/modules/returns/domain/return-request.model.ts`.** A vendor RMA is a
  *sibling* RMA shape, not a mutation of the customer one. It shares the "authorize → ship → acknowledge →
  settle" skeleton but points the other direction: the counterparty is a supplier, not a customer, and the
  goods leave rather than arrive. The customer RMA's inspected lines (`condition` = `damaged`,
  `disposition` = `quarantine`/`scrap`) are the **input** that selects units for a vendor return.
- **The restock/movement seam at
  `apps/retail-microservice/src/modules/returns/application/ports/inventory-restock.gateway.port.ts`.**
  Sending a unit to a supplier is a stock **decrement**, the inverse of a restock — but it must land as a
  movement in the same append-only ledger, through the inventory gateway, never a direct stock write. The
  existing `INVENTORY_RESTOCK_GATEWAY` is the precedent for the port shape; a vendor RMA needs the
  *outbound* counterpart (a "ship-to-supplier" movement) rather than reaching into inventory directly.
- **The supplier party** ([supplier-and-vendor.md](supplier-and-vendor.md)) — the destination. A vendor
  RMA references a supplier id and reads the supplier's return address and terms through that capability's
  seam, exactly as the returns module reads order data through a reader port rather than importing
  `orders/`. The same no-import discipline applies to the supplier context.

## Implementation sketch

- **A `VendorReturn` aggregate**, sibling to `ReturnRequest`, keyed to a `supplierId` and the
  `variantId`/quantity of the units going back. Its lifecycle is supplier-facing:
  `DRAFT → SHIPPED → ACKNOWLEDGED → SETTLED`, where settlement is a **credit note**, a **replacement**, or
  a **repair-return**. It is a separate aggregate because its counterparty, its states and its money
  direction all differ from the customer RMA.
- **Outbound stock movement.** Shipping units to the supplier decrements on-hand through an inventory
  gateway port — a new movement *type* in the append-only ledger (the inventory core owns the movement
  vocabulary), idempotent on the vendor-return id the way restock is idempotent on `returnRequestId`.
  Nothing writes stock outside that seam.
- **Settlement reconciles upstream, not to the customer.** A supplier credit note is a claim the shop
  records against the supplier (a procurement-side ledger the supplier capability owns); a supplier
  *replacement* re-enters sellable stock through the normal restock/receipt path. The customer who
  triggered the original return has **already** been refunded or exchanged on the buyer side — a vendor
  RMA never touches the customer's money.
- **Selection from quarantine.** A batch job or a staff action gathers quarantined/scrapped-but-valuable
  lines by supplier and opens a `VendorReturn` per supplier — the drain from the customer-side disposition
  into the vendor-side lifecycle.
- **Events** ride `ris.events` if added — `retail.vendor-return.shipped` / `.settled`, carrying
  `vendorReturnId` / `supplierId` / `variantId` / quantities, **ids only, no PII** (a supplier is an
  organisation, but its contact people are still personal data governed by the same rail).

## Open design questions

- **Which module owns `VendorReturn`?** It bridges returns (its trigger) and procurement/supplier (its
  counterparty). Placing it in the returns module keeps the trigger local but pulls a supplier dependency
  in; placing it beside the supplier capability keeps procurement cohesive but reads return data across a
  boundary. The [supplier-and-vendor.md](supplier-and-vendor.md) subsystem is the more natural owner once
  it exists.
- **Per-unit traceability** — does the shop need to prove *which* physical unit went back to which
  supplier (serial-level), or is a per-`(supplier, variant, quantity)` claim enough? Serial-level ties
  this to lot/serial tracking; the aggregate quantity is the cheaper default.
- **Settlement matching** — a supplier credit note may arrive weeks later and partially; reconciling it
  against the `VendorReturn` (full, partial, rejected) is its own small ledger-matching problem.
- **Repair-return overlap** — a unit sent to the manufacturer *to be repaired* and returned is both a
  vendor RMA and a [repair workflow](repair-workflows.md); which capability owns the tracking when they
  co-occur?

## Effort sketch

`2–3 capabilities` — the `VendorReturn` aggregate with its supplier-facing lifecycle; the outbound stock
movement through an inventory gateway port; and the settlement reconciliation against the supplier. It is
bounded by inheriting the supplier party from [supplier-and-vendor.md](supplier-and-vendor.md) rather than
modelling it, and by reusing the ledger-movement discipline — the new work is the outbound lifecycle and
its settlement, not the party or the stock primitives.
