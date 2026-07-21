---
title: Buy-now-pay-later state machines
cluster: Order Management
effort: 2–3 capabilities
attaches_to:
  - apps/retail-microservice/src/modules/orders/domain/payment.model.ts
  - apps/retail-microservice/src/modules/orders/application/ports/payment-gateway.port.ts
---

# Buy-now-pay-later state machines

## Description

Buy-now-pay-later (Klarna, Afterpay, Affirm) lets the buyer pay in installments while the merchant is
paid in full up front by the BNPL provider. From the shop's side it is a **tender** like any other — but
one whose authorize-and-settle handshake is **asynchronous and multi-state**: the provider confirms out
of band (a redirect return, a webhook), not synchronously in the place call. Modelling that handshake
correctly, without ever double-charging, is the whole capability.

This guide builds on [gift cards and store credit](gift-cards-and-store-credit.md), which owns the "a
tender that is not a card" argument — `Payment.method` is an opaque string and the `PAYMENT_GATEWAY`
seam already fronts an arbitrary tender, so BNPL needs no new payment column. What BNPL *adds* is the
asynchronous state machine, and the core already has the primitive for it.

## Business needs

- **Higher-ticket conversion** — installment options lift conversion and average order value on
  considered purchases; a shop selling anything expensive leaves revenue on the table without one.
- **Merchant paid up front, provider carries the credit risk** — the appeal is that the shop settles in
  full immediately and never chases installments.
- **Regulated flows** — BNPL is increasingly consumer-credit-regulated, so the state machine and its
  audit trail have to be precise, not best-effort.
- The threshold: a low-ticket impulse-buy shop rarely needs it; a shop with a considered, higher-value
  basket reaches the point where an installment tender pays for itself.

## Attachment points in the current core

- **The `Payment` aggregate at
  `apps/retail-microservice/src/modules/orders/domain/payment.model.ts`.** Its status machine already
  models an asynchronous settlement: `AUTHORIZED → CAPTURING → CAPTURED`, with `beginCapture()` taking a
  durable claim **before** the gateway is called and `releaseCapture()` / `completeCapture()` resolving it
  after (ADR-052). This `CAPTURING` intermediate state is exactly what an async provider confirmation
  needs — a place to sit while the webhook is outstanding.
- **The `PAYMENT_GATEWAY` port at
  `apps/retail-microservice/src/modules/orders/application/ports/payment-gateway.port.ts`** — BNPL rides
  the one seam. `authorize` takes an opaque `method` token (`method = 'bnpl'`), and settlement flows
  through `capture`; a BNPL adapter confines its provider HTTP and webhook handling to `infrastructure/`.
- **The [store-credit / non-card-tender argument](gift-cards-and-store-credit.md)** — inherited whole:
  the reason no new payment column is required.

## Implementation sketch

- **A BNPL adapter behind `PAYMENT_GATEWAY`** whose `authorize` initiates the provider session (returning
  the redirect/handle as the opaque reference) and whose settlement is driven by the provider's
  confirmation, not a synchronous return.
- **The confirmation rides the existing capture claim.** When the provider's webhook (ingested into a
  `ris.events` message, never a new transport) confirms the buyer committed, the settlement path takes
  `beginCapture()` under the row lock — so a duplicate webhook, or a webhook racing a manual capture,
  finds `CAPTURING` rather than `AUTHORIZED` and is rejected *before* reaching the provider (ADR-052).
  **BNPL invents no second capture protocol**; it reuses the one that already exists.
- **The order sees one capture, not the installments.** The provider owns the installment schedule and
  the buyer's repayments; the shop records a single settlement, so `Payment` stays one row and the order's
  payment axis walks `authorized → captured` as usual. The installment ladder is deliberately *not*
  modelled shop-side.
- **A pending-confirmation window** needs a bound and a sweep — the stale-capture-claim scheduler
  precedent (`infrastructure/scheduling/`) surfaces sessions stuck in `CAPTURING`, but, per ADR-052, only
  *surfaces* them; it never resolves a claim it cannot prove landed.
- **Events** ride `ris.events` — `retail.payment.bnpl-initiated`, and the existing
  `retail.payment.captured` on settlement. **No PII in the payload** (ADR-037): the provider needs buyer
  identity, but that goes to it directly from the adapter, never through an internal event.

## Open design questions

- **Webhook trust and idempotency** — a provider webhook is an untrusted, at-least-once inbound; verifying
  its signature and making its handler idempotent (so a redelivery does not double-settle) is the core
  correctness problem, and it maps onto the capture claim but is not free.
- **Redirect-abandonment** — the buyer leaves mid-flow at the provider; the order sits `authorized` with
  no confirmation, and the pending-window sweep has to decide when to void it.
- **Refunds through the provider** — a refund on a BNPL order reverses through the provider's own API and
  has to reconcile with the buyer's remaining installments; the `refund` seam exists but the provider
  semantics differ from a card.
- **Does the shop ever need the installment detail** — for support or dispute handling — or is "paid in
  full" all it should know? Storing more than the single settlement pulls regulated data shop-side.

## Effort sketch

`2–3 capabilities` — the BNPL gateway adapter, the webhook-driven settlement wired onto the existing
capture claim, and the pending-confirmation window. It stays this size precisely because the async
settlement primitive (`CAPTURING` + the claim) and the non-card-tender model already exist; BNPL
composes them rather than adding a new payment state machine.
