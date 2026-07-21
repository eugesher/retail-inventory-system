---
title: Loyalty programs
cluster: Customer & Identity
effort: subsystem-scale (5+ capabilities)
attaches_to:
  - apps/api-gateway/src/modules/auth/domain/customer.model.ts
  - libs/contracts/retail/events/order-placed.event.ts
---

# Loyalty programs

## Description

A loyalty programme earns a customer points on what they spend and lets them burn those points for a
discount, a reward, or a tier upgrade. The mechanics are the same across Shopify's loyalty apps,
Smile.io and LoyaltyLion: a running **points balance** per customer, accrued on qualifying orders,
redeemed at checkout, expiring on a schedule, and often bracketed into ranked **tiers**. The points
balance behaves exactly like a money balance in one crucial respect — it is a **liability the business
owes**, so it is an append-only ledger with a derived balance, not a mutable counter.

This guide owns the **points ledger and its earn/burn lifecycle**. It does **not** own the tier concept:
a loyalty tier is a segment with benefits, and [customer segments and tiers](customer-segments-and-tiers.md)
owns the segment/tier grouping. This guide references those tiers; it does not re-model the grouping.

## Business needs

- **Retention economics** — a repeat customer is cheaper than a new one, and points are the lever that
  turns a one-off buyer into a repeat one.
- **Spend nudging** — "80 points to your next reward" changes basket size, which needs a live, visible
  balance.
- **Tiered treatment** — gold customers get a multiplier and early access, which is a ranked tier
  (owned by the segments guide) with a benefit attached here.
- The threshold: a shop competing purely on price never needs this; the first "earn a point per pound,
  redeem 100 for £5 off" is where a durable, auditable points liability has to exist.

## Attachment points in the current core

- **The `Customer` aggregate at
  `apps/api-gateway/src/modules/auth/domain/customer.model.ts`.** The party a balance attaches to, keyed on
  its `CHAR(36)` UUID. Because the id **survives a tombstone erase** (only the PII columns are nulled), an
  id-keyed points ledger is erasure-safe by construction — it references the surviving id, never a name.
- **The order-placed event at
  `libs/contracts/retail/events/order-placed.event.ts`.** Accrual **consumes** this. The event carries
  `customerId: string | null`, `grandTotalMinor` and `currency` — everything an accrual rule needs, keyed
  on the opaque `customerId`. Note the event *also* optionally carries `customerEmail` for the
  notification fan-out; the accrual ignores it and keys on the id, so no PII enters the points ledger.
- **The `ris.events` firehose.** Accrual is a consumer of an existing event, not a new producer on the
  order path — it rides the topic exchange the event store already binds, with no new transport.

## Implementation sketch

- **Aggregate: `LoyaltyAccount`** (per customer) owning an **append-only `LoyaltyEntry` ledger** of
  **signed** point amounts — earn (+), redeem (−), expire (−), manual adjust (±). This is the
  `stock_movement` / store-credit-ledger precedent applied to points: **the balance is a derived sum,
  never a stored number**, the same discipline as `StockLevel.available`.
- **Accrual** consumes `retail.order.placed`, appends a positive entry keyed **idempotently on
  `orderId`** so a redelivered event never double-accrues (the ADR-036 idempotency posture, applied to a
  consumer). Each append is OCC-checked (ADR-045) so two concurrent writes cannot both spend the last of a
  balance on redemption.
- **Redemption** is the open money-shaped call. Either points are a **tender** — a `Payment` with an
  opaque `method = 'loyalty-points'` behind an internal-tender adapter that debits the ledger, exactly the
  seam the store-credit guide establishes — **or** points are a **discount** that writes the order's
  `discountTotalMinor`. The first keeps loyalty a payment concern; the second keeps it a pricing concern.
- **Tiers** are ranked segments defined by the segments guide; this capability reads a customer's tier to
  apply an **earn multiplier** or a redemption bonus. It does not store tier membership — that is the
  segment's.
- **Expiry** is a scheduled sweep (the orders/inventory `*.scheduler.ts` precedent) appending negative
  expiry entries for points past their earn-date window — a compensating entry, never a mutation.
- **Events** ride `ris.events` — `retail.loyalty.accrued` / `.redeemed` / `.expired`, carrying
  `customerId` + amounts only. **No PII** (ADR-037).
- **Cache.** A balance read is cache-aside under a **new** `CACHE_KEYS.loyaltyBalance(customerId)` builder
  with its own version segment (no loyalty builder exists today), invalidated by-prefix post-commit on
  every append.

## Open design questions

- **Redemption as tender or discount** (above) — the single highest-leverage choice, because it decides
  whether loyalty plugs into `Payment` or into the order's discount total.
- **What erasure does to a balance.** The ledger is id-keyed and PII-free, so it *can* survive an erase as
  a financial record — but a points balance is a liability the business may owe, and a "right to be
  forgotten" may require forfeiting it. Forfeit-on-erase (append a closing negative entry, tombstone the
  account) vs. retain-as-liability (keep the id-keyed ledger) is a genuine legal-and-accounting decision,
  not a technical one. **The guide is incomplete without stating it, and this is the statement:** default
  to forfeiture on erase unless an accounting obligation says otherwise.
- **Accrual base** — points on the grand total, on the pre-tax subtotal, or on eligible lines only? The
  event carries `grandTotalMinor`; a line-level base needs the order lines, a heavier read.
- **Fractional points and rounding** — integer points with a documented rounding rule, matching the
  minor-units money discipline, or fractional points with their own precision.

## Effort sketch

`subsystem-scale (5+ capabilities)` — the `LoyaltyAccount` + append-only ledger, the accrual consumer, the
redemption path (tender or discount), tier-multiplier reads, and the expiry sweep. It is a subsystem
because it introduces a durable liability with its own lifecycle, not a single field.
