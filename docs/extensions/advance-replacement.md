---
title: Advance replacement
cluster: Returns & Refunds
effort: 2–3 capabilities
attaches_to:
  - apps/retail-microservice/src/modules/returns/domain/return-request.model.ts
  - apps/retail-microservice/src/modules/orders/domain/order.model.ts
---

# Advance replacement

## Description

**Advance replacement** ships the substitute *before* the returned item arrives — the customer gets the
working unit first and sends the broken one back afterwards, often with a prepaid label and a deadline.
It is the highest-service, highest-risk point on the returns spectrum: the shop has parted with two units
and holds none until the original comes back, and it may never come back. Crucially, advance replacement
is **not a new way to model the swap** — it composes the exact pieces
[exchanges-as-first-class-entity.md](exchanges-as-first-class-entity.md) and
[replacement-orders-distinct-entity.md](replacement-orders-distinct-entity.md) already define. What makes
it its own capability is the **ordering and the risk**: the outbound leg fires first, so the shop needs a
credit-risk gate before it ships and a reconciliation obligation after — a stock-commitment and
credit-control problem sitting on top of a modelling problem that is already solved.

Where the three cluster siblings differ (the split is owned by
[exchanges-as-first-class-entity.md](exchanges-as-first-class-entity.md)):

- a **replacement order** is a new `Order` linked to the original, no timing constraint;
- an **exchange** binds the inbound return and outbound order into one deal that settles together;
- an **advance replacement** is an exchange (or a replacement) whose outbound leg is *deliberately shipped
  first*, against the promise of a return that has not happened yet.

## Business needs

- **B2B / mission-critical goods** — a failed server part, a medical device, a piece of production
  equipment cannot wait for a return-inspect-reship cycle; the replacement must ship today and the failed
  unit follows.
- **Premium warranty tiers** — "next-business-day advance replacement" is a sold service level;
  supporting it is a revenue feature, not a courtesy.
- **Return enforcement** — the shop that ships first needs a lever to get the original back: an
  authorization hold, a deadline after which the customer is charged, and a way to release or capture that
  hold when the return lands (or does not).
- The threshold: the first time a customer cannot tolerate downtime and the shop is willing to trust them
  with two units to win the account is where advance replacement earns its risk.

## Attachment points in the current core

- **The `ReturnRequest` aggregate at
  `apps/retail-microservice/src/modules/returns/domain/return-request.model.ts`.** The inbound leg is an
  ordinary RMA — but advance replacement **inverts the timeline**. Normally the outbound waits for
  `RECEIVED`/`INSPECTED`; here the outbound order ships while the RMA is still merely `AUTHORIZED` (or even
  at `REQUESTED`, on trust). The RMA gains an expectation — *this return is owed* — and a deadline against
  which non-arrival triggers a charge. The lifecycle states are unchanged; what changes is that the
  outbound obligation is discharged out of order.
- **The `Order` aggregate at
  `apps/retail-microservice/src/modules/orders/domain/order.model.ts`.** The outbound leg is a new
  `Order` (the [replacement-orders-distinct-entity.md](replacement-orders-distinct-entity.md) decision):
  it needs lines, stock allocation, a fulfilment and a delivery, all of which hang off `Order`. Advance
  replacement adds nothing to `Order` itself — it changes *when* the order is created (before receipt) and
  attaches a **credit hold** that the return's arrival resolves. Because `returns/` may not import
  `orders/`, the returns side drives that order through the existing cross-module RPC and reads its state
  through a reader port, never the imported aggregate.
- **The payment/credit seam.** The risk control is an authorization on the customer's payment method for
  the replacement's value, captured only if the return misses its deadline. That is the existing
  `PAYMENT_GATEWAY` authorize/capture pair, reached from the returns side without importing `orders/`.

## Implementation sketch

- **Compose, don't re-model.** An advance replacement is an [exchange](exchanges-as-first-class-entity.md)
  (or a bare replacement) with an `advance = true` flag and a **return deadline**. It reuses the exchange's
  two-legged binding and the replacement-as-a-new-`Order` decision wholesale; its own additions are the
  *ship-first ordering* and the *risk hold*.
- **The credit hold is the core new mechanism.** Before the outbound order ships, authorize the
  replacement's value on the customer's payment method (existing `PAYMENT_GATEWAY.authorize`). Three
  outcomes: the return arrives in good order → **void** the hold; the return arrives damaged/incomplete →
  capture the appropriate amount; the deadline passes with no return → **capture** the full hold. This is
  the same authorize/capture lifecycle checkout uses, pointed at a returns deadline instead of a
  fulfilment.
- **A deadline sweep.** Non-arrival is a *timeout*, so the capture-on-expiry needs a scheduled sweep —
  the reservation-sweep precedent in inventory (a periodic job over rows past a cutoff), not a new
  bespoke timer design. The sweep finds advance replacements past their return deadline with no receipt
  and captures the hold.
- **Stock commitment.** The outbound order allocates stock at ship time exactly as any order does; the
  *inbound* stock is not counted until it physically arrives and is inspected — the shop is genuinely
  short one unit in between, and that is honest in the ledger rather than pre-credited (the "audit, not
  balance" discipline the inventory core already holds).
- **Events** ride `ris.events` if added — `retail.return.advance-shipped` / `.return-overdue`, carrying
  ids, amounts and the deadline, **no PII**.

## Open design questions

- **How much trust, and gated by what?** Ship-first to everyone is a fraud magnet; ship-first only to
  scored-low-risk customers ties advance replacement to [return-fraud-scoring.md](return-fraud-scoring.md)
  or an account-standing check. The gate's strictness is a policy the capability must expose, not bake in.
- **Void vs. partial capture on a damaged return.** If the returned unit arrives but fails inspection, is
  the hold captured in full, partially (a restocking/damage fee), or voided with a separate charge? This
  reuses the inspection disposition but adds a money decision the current close path does not make.
- **What zero-values the replacement order** — inherited unresolved from
  [replacement-orders-distinct-entity.md](replacement-orders-distinct-entity.md) (zero-priced lines vs. a
  100% order discount). Advance replacement is indifferent to the choice but must pick the same one the
  exchange path picks.
- **Deadline length and its source** — a per-order default, a per-customer-tier value, or a
  configuration token like the return window? It should arrive through DI the way `RETURN_WINDOW_DAYS`
  does, never as a literal.

## Effort sketch

`2–3 capabilities` — the advance flag and return deadline on top of the exchange/replacement binding; the
authorize-hold-then-void-or-capture risk mechanism; and the deadline sweep that captures on non-arrival.
It is bounded because the *swap* is already modelled by the two guides it composes — the new work is the
risk control and the timeout, not the exchange itself.
