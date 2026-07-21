---
title: Repair workflows
cluster: Returns & Refunds
effort: 2–3 capabilities
attaches_to:
  - apps/retail-microservice/src/modules/returns/domain/return-line.model.ts
  - apps/retail-microservice/src/modules/returns/application/ports/inventory-restock.gateway.port.ts
---

# Repair workflows

## Description

A **repair workflow** handles the return path where the goods are neither refunded-and-scrapped nor
refunded-and-restocked, but **fixed and sent onward** — back to the customer under warranty, or to
sellable stock as a refurbished unit. Watches, power tools, bicycles, furniture and electronics all have
this path: the item comes in, is assessed, goes *out* to a bench or a repair vendor, and comes *back* to
be routed to its destination. The universal core has no room for the middle of that: its return
dispositions are all **terminal** — an inspected line resolves to `restock`, `scrap`, or `quarantine` and
the RMA proceeds to close. A repair is the one disposition that **leaves and comes back**, and modelling
it means giving a returned line a state it can sit in while it is neither in the shop nor resolved.

## Business needs

- **Warranty repair** — a customer with an in-warranty defect is entitled to a fix, not a refund; the
  shop must accept the item, repair it (in-house or via the manufacturer), and return the *same* unit.
- **Refurbishment** — a returned-damaged item worth fixing becomes resellable at a refurbished grade
  rather than being scrapped; the repair cost is weighed against the recovered value.
- **Repair-cost accountability** — a repair has a labour and parts cost, sometimes billable to the
  customer (out-of-warranty), sometimes absorbed; someone has to record which.
- The threshold: the first product line the shop sells that is *worth fixing* — anything durable and
  non-trivially priced — is where a `scrap`-or-`restock` binary stops being enough.

## Attachment points in the current core

- **The line disposition at
  `apps/retail-microservice/src/modules/returns/domain/return-line.model.ts`.** At inspection a
  `ReturnLine` records one of `ReturnDispositionEnum` = `restock` / `scrap` / `quarantine` via
  `inspect(...)`, and the field is **mutable exactly once** — `null` from Open until inspection sets it.
  A repair breaks that "once" assumption: the line needs a disposition that is **not final at
  inspection** — it enters `repair`, and only when the repair completes does its true destination
  (back-to-customer or restock-as-refurbished) resolve. That single-write invariant is the concrete thing
  a repair sketch has to revisit.
- **The restock gateway port at
  `apps/retail-microservice/src/modules/returns/application/ports/inventory-restock.gateway.port.ts`.**
  A repaired unit that becomes sellable stock re-enters inventory through the **same**
  `INVENTORY_RESTOCK_GATEWAY.restockFromReturn(...)` seam any restocked line uses — a movement in the
  append-only ledger, idempotent on `returnRequestId`, run *after* the local commit. The difference is
  **timing**, not path: a normal restock fires at inspection; a repaired-then-restocked unit fires when
  the repair closes, possibly days later. A unit repaired and returned *to the customer* never restocks
  at all — the gateway is simply not called for it.
- **The RMA lifecycle it sits inside.** `ReturnRequest` (`return-request.model.ts`) walks
  `RECEIVED → INSPECTED → CLOSED`. A repair defers `CLOSED`: the RMA cannot close while a line is still
  out for repair, so the parent status gains a "resolution pending" tail the current five-state walk does
  not have.

## Implementation sketch

- **A `repair` disposition, plus a small repair sub-record.** Add `REPAIR` to the line dispositions and
  a `RepairJob` (or a repair state on the line) holding: assigned bench/vendor, in/out timestamps,
  parts/labour cost, and the **final** destination (`return-to-customer` / `restock-refurbished` /
  `scrap-after-assessment`). The line's inspection disposition becomes provisional — `repair` is a
  *deferral*, and the final disposition is written when the job closes.
- **Deferred restock.** When a repair resolves to `restock-refurbished`, the use case calls
  `INVENTORY_RESTOCK_GATEWAY` at *that* moment, not at inspection — reusing the existing idempotent
  seam so a retried close does not double-restock. A refurbished grade may warrant a distinct location or
  a condition tag, but the *movement* is the ledger append that already exists.
- **The RMA holds open.** `ReturnRequest.close` is gated until every line has a *final* disposition, so a
  repair-in-progress keeps the RMA in a pending tail rather than closing it. This is a new terminal-guard
  on the aggregate, not a new lifecycle.
- **Cost tracking, not payment.** Repair cost is recorded on the `RepairJob`; charging the customer for an
  out-of-warranty repair reuses the orders-side `Payment` seam through a reader/gateway rather than
  reaching into `orders/` — repair does not become a second checkout.
- **Vendor repairs** (item sent to the manufacturer) borrow the same party a
  [vendor RMA](vendor-rmas.md) routes to, if that capability exists; a repair bench is the in-house
  degenerate case of the same "goods leave, tracked, and return" shape.
- **Events** ride `ris.events` if added — `retail.return.repair-started` / `.repair-completed`, carrying
  `returnRequestId` / line ids / disposition, **no PII**.

## Open design questions

- **A new disposition, or a new line state orthogonal to disposition?** Making `repair` a disposition is
  the smallest change but overloads a field the code treats as a final, write-once decision; a separate
  `repairStatus` keeps the disposition honest (the disposition is still the *outcome*, recorded when the
  repair ends) at the cost of a second state field to reconcile.
- **Where does the repaired unit's provenance live?** A refurbished unit restocked at a different grade
  is arguably a different sellable thing; whether that is a location, a condition attribute, or a distinct
  variant is a modelling call that reaches into inventory, not just returns.
- **In-house bench vs. external repair vendor** — one `RepairJob` shape covering both, or a split where
  the vendor case reuses the supplier party and the in-house case is a bare bench assignment?
- **Billing an out-of-warranty repair** — is the repair cost a `Payment` on a small ad-hoc order, a line
  on the original order, or a separate invoice the core does not model at all?

## Effort sketch

`2–3 capabilities` — the `repair` disposition and the deferred final-disposition it implies; the
`RepairJob` sub-record with cost and destination; and the deferred restock plus the RMA close-guard.
It is bounded by reusing the restock ledger seam and the RMA lifecycle unchanged — the new work is the
*non-terminal middle*, which is genuinely new state, hence more than one capability but well short of a
subsystem.
