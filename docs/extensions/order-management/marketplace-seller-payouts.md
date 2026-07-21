---
title: Marketplace seller payouts
cluster: Order Management
effort: subsystem-scale (5+ capabilities)
attaches_to:
  - apps/retail-microservice/src/modules/orders/domain/payment.model.ts
  - apps/retail-microservice/src/modules/orders/domain/refund.model.ts
---

# Marketplace seller payouts

## Description

A marketplace is a shop where the goods belong to third-party sellers, not the platform. The buyer
still pays once, for one order that may span several sellers; the platform then disburses to each seller
what they earned, minus a commission. This is the money-splitting problem: **one capture in, many
payouts out.** Amazon Marketplace, Etsy and Shopify's collective/marketplace models all run this
two-sided flow, and platforms like Stripe Connect and Adyen for Platforms exist specifically to settle
it.

This guide builds on the [supplier / vendor party](../product-catalog/supplier-and-vendor.md) — a marketplace *seller* is
that same party, now cast as the owner of goods being sold rather than a supplier the shop buys from. It
does not re-model the party; it decides how the single buyer payment becomes per-seller payouts.

## Business needs

- **Multi-seller catalogs** need per-seller accounting: each seller sees their sales, their commission
  and their payout, not a platform lump sum.
- **Commission** is the platform's revenue model, so the split between seller earnings and platform take
  has to be recorded per line, auditable, and reconcilable.
- **Payout scheduling** (daily, weekly, on-delivery, on-return-window-close) is a real business lever —
  holding funds until the return window closes is how a marketplace limits its own exposure.
- The threshold: a single-seller shop never needs this; the first order that contains two sellers' goods
  is where one capture has to fan out into two payouts.

## Attachment points in the current core

- **The `Payment` aggregate at
  `apps/retail-microservice/src/modules/orders/domain/payment.model.ts`.** The buyer still makes **one**
  capture for the whole order — `Payment` is unchanged. The payout is a *downstream disbursement*, not a
  second charge, so it attaches alongside `Payment` rather than modifying it.
- **The `Refund` aggregate at
  `apps/retail-microservice/src/modules/orders/domain/refund.model.ts`** — a refund on a marketplace
  order has to claw back the corresponding seller's payout (or net it against future payouts), so the
  payout ledger has to reconcile with refunds.
- **The seller party** in the [supplier / vendor guide](../product-catalog/supplier-and-vendor.md) — the payout
  recipient is that `Supplier`/seller, and the `variantId` on each `OrderLine` is what attributes a line
  to a seller through the supply relationship.

## Implementation sketch

- **A new `Payout` ledger, append-only** — the `stock_movement` / store-credit-ledger precedent. Each
  captured order fans out into signed payout entries per seller: gross line revenue `+`, platform
  commission `−`, refunds and chargebacks `−`. A seller's **payable balance is a derived sum**, never a
  stored mutable number, and a scheduled disbursement is a settlement against it. This likely lives in
  the Procurement/Marketplace context beside the seller party, not inside `orders/`.
- **Commission is computed at capture and recorded, not recomputed** — the same discipline as an order
  total: a rate change must not retroactively alter a settled payout. The computed split is written when
  the order captures.
- **Disbursement is a money-moving write** and joins the request-level idempotency set (ADR-036): the
  key is deterministic per `(sellerId, payoutPeriod)` so a re-run of the payout job cannot pay a seller
  twice. Every ledger append is version-checked OCC (ADR-045).
- **Currency follows the immutable order.** A payout is denominated in the order's `currency`, which is
  fixed forever; cross-currency settlement to a seller in another currency is an explicit FX step, never
  an implicit reinterpretation of the stored amount.
- **No PII, and no seller bank details, over the bus** (ADR-037) — `retail.payout.accrued` /
  `.disbursed` carry seller ids, amounts and references, never account numbers. Bank details are a
  secret held in the seller party's own store, never in an event payload or an audit row.
- **Payout scheduling** is a scheduler under `infrastructure/scheduling/` (the existing timer
  precedent), its cadence arriving through a value-provider token.

## Open design questions

- **When does a payout become payable — at capture, at delivery, or at return-window-close?** Holding
  until the window closes limits clawback risk but delays seller cash; this is the central policy call.
- **Refund attribution** — when a buyer refund spans the platform's commission and the seller's
  earnings, who absorbs which part, and can a payout go negative (a seller owing the platform)?
- **Split capture vs. split settlement** — is the buyer's money captured once and then redistributed
  (simplest, platform holds funds), or captured directly to each seller (needs a gateway that supports
  split payments, e.g. Connect)? This decides whether `Payment` stays a single row.
- **Tax on commission** and cross-border seller obligations sit on top and interact with the
  [tax engine](tax-computation-engine.md).

## Effort sketch

`subsystem-scale (5+ capabilities)` — the payout ledger, commission computation, disbursement
scheduling, refund/clawback reconciliation, and per-seller reporting, on top of split-capture decisions.
It is a full two-sided money subsystem, which is why it is not a single capability even though it reuses
the `Payment` row and the seller party.
