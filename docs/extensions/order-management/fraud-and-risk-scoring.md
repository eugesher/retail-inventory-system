---
title: Fraud and risk scoring
cluster: Order Management
effort: 2–3 capabilities
attaches_to:
  - apps/retail-microservice/src/modules/orders/application/use-cases/place-order.use-case.ts
  - apps/retail-microservice/src/modules/orders/application/ports/payment-gateway.port.ts
---

# Fraud and risk scoring

## Description

Risk scoring asks, at checkout, *should this order be allowed to proceed?* — and lets the answer block,
hold, or wave the order through. Scoring is almost always **external**: Signifyd, Riskified, Stripe
Radar and Kount are specialist providers that see far more fraud signal than any single shop, and they
are consulted through an integration, not reimplemented in-house. The shop's job is to place the call at
the right moment and to act on the verdict.

This guide **owns the risk-scoring seam** — where a score is requested, what it is allowed to block, and
the fact that scoring is an external port rather than an internal rules engine. A later returns-side
return-fraud-scoring guide will reuse this seam against return requests instead of orders; it inherits
the port and the block/hold/allow verb set defined here.

## Business needs

- **Card-not-present fraud** is the online shop's largest loss category; a score that blocks the worst
  orders before authorize is direct loss prevention.
- **Chargeback liability** — a mis-shipped fraudulent order costs the goods *and* the chargeback fee;
  scoring shifts that decision earlier.
- **Manual-review queues** — most orders clear automatically, a thin band needs a human, and outright
  blocks are rare; the seam has to express all three outcomes, not a boolean.
- The threshold: a low-risk or invite-only shop can run without it; a high-volume consumer shop taking
  cards from strangers reaches the point where a score has to gate placement.

## Attachment points in the current core

- **The place-order path at
  `apps/retail-microservice/src/modules/orders/application/use-cases/place-order.use-case.ts`.** This is
  the single point where the score is requested — after the order is assembled and before (or instead
  of) the authorize. Placing the call anywhere else either scores an order that does not exist yet or one
  that has already charged. The `place` flow commits the order, converts the cart, allocates stock and
  *then* authorizes; the score sits in that window.
- **The `PAYMENT_GATEWAY` port at
  `apps/retail-microservice/src/modules/orders/application/ports/payment-gateway.port.ts`** — the
  precedent for the seam. It is a domain/contract port fronting an external provider with **no transport
  import** (HTTP lives in the adapter). A `RISK_SCORING_GATEWAY` port is the same shape: a clean port, an
  infrastructure adapter that makes the actual call.
- **The `ris.events` stream** — order velocity, prior chargebacks and past behaviour form a read-model
  risk profile fed from the firehose; the synchronous decision is still the port call at place time.

## Implementation sketch

- **A `RISK_SCORING_GATEWAY` port**, mirroring `PAYMENT_GATEWAY`: `score(request) → verdict`. The bound
  adapter calls the external provider; a default no-op adapter always allows (the `FakePaymentGateway`
  precedent), so the seam exists before any provider is wired.
- **The verdict is a three-way outcome, not a boolean** — `allow`, `hold` (place the order but mark it
  for manual review), `block` (reject before authorize). `hold` needs somewhere to live: a review flag,
  or a new value on a status axis. Because ADR-028 §2 keeps the axes orthogonal, review state should be
  its **own** signal, not folded into the payment or lifecycle axis.
- **The request carries no PII** (ADR-037). This is the load-bearing constraint: a score request that
  ships the buyer's email, name or address over the internal bus would violate the no-PII-in-events rule.
  The provider integration passes signals (amount, item count, velocity, device fingerprint) and opaque
  ids; any PII the external provider genuinely needs goes **directly** to it from the adapter over its own
  channel, never through `ris.events` or an audit row.
- **A blocked order is unwound cleanly** — because the score is requested before authorize, a block means
  no capture ever happened; the order either never commits or is cancelled via `markPaymentFailed()` +
  `cancel()` (the ADR-052 decline path), releasing the allocated stock.
- **Events** ride `ris.events` — `retail.order.risk-scored`, `retail.order.held-for-review` — carrying
  the verdict and score band, never the signals.

## Open design questions

- **Synchronous block vs. asynchronous review.** Blocking needs a synchronous call in the place path
  (adds latency, and a provider outage must fail open or closed — a real decision); review can be
  after-the-fact. Which outcomes are synchronous shapes the whole flow.
- **Where does `hold` state live**, and who works the queue? A held order that nobody reviews is a lost
  sale, so the review workflow is part of the capability, not an afterthought.
- **Fail-open or fail-closed** when the scoring provider is unreachable — accepting risk vs. losing
  legitimate orders is a business-risk call with no universal answer.
- **What signals are available without PII** — assembling a useful feature vector from ids and
  aggregates alone constrains how good an in-house-fed score can be.

## Effort sketch

`2–3 capabilities` — the scoring port and adapter, the three-way verdict wired into the place path, and
the hold/review state. It stays this size by **reusing** the gateway-port pattern and the existing
decline-unwind rather than building a rules engine; the heavy lifting is deliberately the external
provider's.
