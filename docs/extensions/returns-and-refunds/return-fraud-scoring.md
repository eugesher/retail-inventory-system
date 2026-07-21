---
title: Return fraud scoring
cluster: Returns & Refunds
effort: 1 capability
attaches_to:
  - apps/retail-microservice/src/modules/returns/domain/return-request.model.ts
  - apps/retail-microservice/src/modules/returns/application/use-cases/
---

# Return fraud scoring

## Description

**Return fraud scoring** asks, when a customer opens a return, *should this return be allowed, held for
manual review, or refused?* — the returns-side mirror of order fraud scoring. Return abuse is a distinct
loss category: wardrobing (buy, wear, return), empty-box and item-swap returns, serial returners whose
return rate destroys margin, and receipt/refund fraud. This guide **inherits the risk-scoring seam** from
[fraud-and-risk-scoring.md](../order-management/fraud-and-risk-scoring.md) — the same external `RISK_SCORING_GATEWAY` port and
the same **block / hold / allow** verb set — and points it at a `ReturnRequest` instead of an `Order`. It
does not build a rules engine; scoring is an external call, and the shop's job is to place it at the right
moment in the RMA lifecycle and act on the verdict.

Because a return decision is *about a person's behaviour*, this is the cluster's likeliest place to leak
personal data onto the bus — so the rail is stated up front: **the score request and every event it emits
carry ids, not PII.**

## Business needs

- **Return abuse is a margin sink** — wardrobing and serial returns turn a nominally profitable customer
  into a net loss; a score that flags the pattern lets the shop act before authorizing the RMA.
- **Empty-box / swap fraud** — a return that arrives empty or with a substituted item is a direct theft;
  scoring at open, plus tighter inspection on high-risk returns, is the control.
- **Policy enforcement at scale** — "no more than N returns per period", "no returns on final-sale items"
  are rules a score can encode without staff adjudicating every case.
- The threshold: the first time return losses are large enough to justify an external scoring provider —
  typically once order-side [fraud scoring](../order-management/fraud-and-risk-scoring.md) already exists and the same seam can
  be reused.

## Attachment points in the current core

- **The `ReturnRequest` aggregate at
  `apps/retail-microservice/src/modules/returns/domain/return-request.model.ts`.** The natural scoring
  moment is at **Open** (`REQUESTED`) — before `authorize`. A `hold` verdict maps cleanly onto the
  existing `REQUESTED → AUTHORIZED` / `REQUESTED → REJECTED` fork: the RMA simply waits in `REQUESTED` for
  a staff decision, and a `block` verdict drives `reject(at, reason)`. The lifecycle already has the
  states a three-way verdict needs; scoring supplies the *input* to the fork, it adds no new status.
- **The Open use case at
  `apps/retail-microservice/src/modules/returns/application/use-cases/`.** `OpenReturnRequestUseCase`
  already resolves the order (through `RETURN_ORDER_READER`) and enforces the returnable-quantity
  invariant; the score request slots in beside that resolution — the use case is where the external port
  is called and the verdict is applied, exactly as order-side scoring lives in `PlaceOrderUseCase`.
- **The `RISK_SCORING_GATEWAY` seam** ([fraud-and-risk-scoring.md](../order-management/fraud-and-risk-scoring.md)) — the
  inherited external port. It is the same provider integration and the same block/hold/allow verdict; a
  return score is a second call type against it, not a second port. The seam is transport-free and
  unit-testable the way the returns module's other gateway ports are.

## Implementation sketch

- **Score at Open, act on the verdict.** In `OpenReturnRequestUseCase`, after the returnable-quantity
  check, call `RISK_SCORING_GATEWAY` with a return-scoring payload and branch: `allow` → proceed to
  `REQUESTED` as today; `hold` → open `REQUESTED` but flag for manual review (no auto-authorize); `block`
  → `reject` with a reason, or refuse to open at all per policy.
- **The signal is the customer's return history** — return rate, prior fraud flags, order value, account
  age. The returns module computes its own history from `RETURN_REQUEST_REPOSITORY.listByOrderId` /
  by-customer reads and passes **derived, id-keyed signals** to the provider — it does not need to widen
  the order reader much, and it must not assemble a PII dossier to do it.
- **The no-PII rail is load-bearing here.** The score *request* leaves the system to an external provider,
  and any event it emits rides `ris.events` into the durable firehose — so both carry **`customerId`,
  order/return ids, and numeric signals only, never name/email/address**. A provider that needs richer
  identifiers is integrated through the adapter with the shop's data-processing agreement, exactly as the
  order-side scoring adapter is — the *domain event and the audit row stay id-only* (ADR-037 §4). This is
  the rail the guide most has to defend, because a fraud sketch is the natural place to be tempted to log
  "who".
- **Idempotency and failure posture.** Scoring is best-effort at Open: a provider timeout must not block a
  legitimate return — fail open to `hold` (manual review) rather than `block`, so an outage does not
  refuse every return.
- **Events** ride `ris.events` if added — `retail.return.scored` with `returnRequestId` / `customerId` /
  verdict / numeric score, **no PII**.

## Open design questions

- **Score at Open or at Inspect?** Open catches abuse before authorizing (cheapest); Inspect catches
  empty-box/swap fraud that only shows when the goods arrive. The honest answer may be *both*, with
  different actions — a hold at Open, a claw-back/flag at Inspect.
- **Fail-open vs. fail-closed on a provider outage** — failing open keeps legitimate returns flowing but
  lets abuse through during an outage; failing closed protects margin but punishes honest customers for an
  integration failure. The default here is fail-open-to-hold, but it is a risk-appetite call.
- **Same provider as order scoring, or a returns specialist?** Reusing the order-side provider maximises
  signal sharing; some fraud vendors score returns as a distinct product. The *seam* is identical either
  way — this is an adapter-configuration question, not a modelling one.
- **What a `block` does to an existing entitlement** — refusing a return on a genuinely defective item has
  consumer-law limits; the block verb needs a policy boundary so it cannot refuse a return the shop is
  legally obliged to accept.

## Effort sketch

`1 capability` — a score call in the Open use case, a three-way branch onto the RMA's existing
`REQUESTED`/`AUTHORIZED`/`REJECTED` fork, and the id-only signal assembly. It is genuinely small **because**
it inherits the `RISK_SCORING_GATEWAY` port and the block/hold/allow verb set from
[fraud-and-risk-scoring.md](../order-management/fraud-and-risk-scoring.md) and reuses the RMA lifecycle unchanged — the new
work is the returns-side signal and the discipline that keeps PII off the request and the bus.
