---
title: Transfer orders as workflow documents
cluster: Inventory
effort: 2–3 capabilities
attaches_to:
  - apps/inventory-microservice/src/modules/stock/application/use-cases/transfer-stock.use-case.ts
  - apps/inventory-microservice/src/modules/stock/domain/stock-movement.model.ts
---

# Transfer orders as workflow documents

## Description

The core can already move stock between two locations — but it does so **instantaneously and
atomically**. There is no document, no approval, no in-flight state: stock leaves the source and lands
at the destination in a single committed transaction. That is correct for a same-building move and
wrong for a real inter-warehouse transfer, which takes days, needs a picking list, may be approved,
may ship partially, and can lose units on the road.

This guide adds the **transfer order document** — a first-class aggregate with a lifecycle (draft →
dispatched → in transit → received) wrapped around the atomic move the core already performs. It owns
this premise for the cluster: [in-transit as a separate location](in-transit-as-separate-location.md)
links here for where the goods sit between dispatch and receipt. NetSuite, SAP and larger WMS platforms
all model transfer orders as documents for exactly this reason.

## Business needs

- **Multi-warehouse retailers** need an auditable, approvable document for stock moving between
  distribution centres, not a silent adjustment.
- **Transfers that take time** need an in-transit period: stock has left the source but has not yet
  arrived, and both facts must be visible.
- **Partial and damaged receipts** need a document to reconcile against — 100 dispatched, 98 received,
  2 lost.
- The threshold: a single-location business never transfers; a business whose transfers are same-room
  is served by the atomic move; a business moving stock across distance and time needs the document.

## Attachment points in the current core

- **`TransferStockUseCase`, at `apps/inventory-microservice/src/modules/stock/application/use-cases/transfer-stock.use-case.ts`.**
  This is the atomic move to wrap. Read it before extending it: a transfer today is a **pair of
  `adjustment` movements** sharing one `referenceType: 'transfer'` and one `referenceId`, the source
  leg negative (`transfer-out`) and the destination leg positive (`transfer-in`), committed in a
  single transaction. **There is no `transfer` movement type and no in-transit state** — the sign-per-type
  invariant is kept precisely because `adjustment` is the only type allowed either sign.
- **The `inventory.stock-level.transfer` routing key** is the operation this document's *execution*
  steps would drive, in stages rather than in one shot.
- **`StockMovement`, at `apps/inventory-microservice/src/modules/stock/domain/stock-movement.model.ts`.**
  The ledger is append-only; a cancelled or corrected transfer is a **compensating `adjustment`
  movement**, never an edit or delete of the original leg.

## Implementation sketch

- **A `TransferOrder` aggregate** (owns `TransferOrderLine`s) in the stock module, with a status
  lifecycle: `draft` → `dispatched` → `received` (and `cancelled`). It is a **mutable aggregate** with
  version-checked OCC, unlike the immutable ledger rows it will produce.
- **Split the atomic move in two along the timeline.** Dispatch writes the source-leg `adjustment`
  (`transfer-out`) and debits source on-hand; receipt writes the destination-leg `adjustment`
  (`transfer-in`) and credits destination on-hand. The paired `referenceId` is now the transfer order's
  id, so the two legs remain queryable as one transfer — the current pairing convention, stretched over
  time.
- **The gap between the two legs is in-transit stock** — where it lives (still on the source's books, a
  virtual location, or document-owned limbo) is the seam [in-transit as a separate
  location](in-transit-as-separate-location.md) resolves.
- **Each leg keeps its OCC and idempotency.** Dispatch and receipt are separate money-/stock-moving
  writes, each version-checked; a re-delivered receipt must be idempotent, following the reference-based
  dedupe the ledger already uses for commit-sale and restock
  ([ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md)).
- **Events** on `ris.events`: `inventory.transfer-order.drafted` / `.dispatched` / `.received` /
  `.cancelled`, dotted `<service>.<aggregate>.<action>`, captured by the firehose with no new binding.
  Shared transfer-order views under `libs/contracts/inventory/`.

## Open design questions

- **Where does in-transit stock sit?** The central call, and the reason the [in-transit
  guide](in-transit-as-separate-location.md) exists: on the source until received, in a virtual
  location, or owned by the document itself. Each changes what `available` at each end reports mid-flight.
- **Partial receipt handling.** If 100 dispatch and 98 arrive, does the order stay open, close short,
  or spawn a discrepancy record? The two missing units are a loss `adjustment` against in-transit, not
  a silent gap.
- **Approval and reservation semantics.** Should a draft transfer *reserve* stock at the source so it
  cannot be sold out from under the transfer? That re-uses the reservation aggregate for a non-cart
  hold — a genuine extension of what a `Reservation` means.
- **Does the document supersede the atomic move, or coexist?** Same-building moves may still want the
  one-shot path; keeping both means two code paths writing the same ledger pair.

## Effort sketch

`2–3 capabilities` — the `TransferOrder` aggregate and its lifecycle, the split of the atomic move into
timed dispatch and receipt steps, and the in-transit reconciliation. The ledger's sign rule and the
paired-`adjustment` convention are reused unchanged, which bounds the blast radius.
