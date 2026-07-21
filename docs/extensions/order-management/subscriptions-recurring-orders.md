---
title: Subscriptions and recurring orders
cluster: Order Management
effort: subsystem-scale (5+ capabilities)
attaches_to:
  - apps/retail-microservice/src/modules/orders/domain/order.model.ts
  - apps/retail-microservice/src/modules/orders/infrastructure/scheduling/
---

# Subscriptions and recurring orders

## Description

This is the **recurrence engine** — the half of the subscription story that runs on a clock. A
[selling plan](../product-catalog/subscriptions-and-selling-plans.md) says *what* can be bought on a cadence and how its
recurring price relates to the one-off `price` ledger; this guide is what actually generates an
`Order` every cycle, charges it, and copes when the charge fails. Shopify splits the same way (Selling
Plans define the offer; a separate subscription contract drives the billing), and so does
commercetools' recurring-order model.

The boundary is not this guide's to renegotiate — the plan guide draws it, verbatim, and this guide
quotes it: *the plan (subscribable variants, cadences, price relationship) lives in the catalog; the
engine (scheduled `Order` generation, the payment retry ladder, dunning, pause and skip) lives here in
order management.* The catalog never runs a clock; a subscription instance is order data, not product
data.

## Business needs

- **Replenishables** (coffee, supplements, pet food) and **membership boxes** need an order to
  materialise on schedule without the customer re-checking-out each time.
- **Dunning** — the retry-and-notify ladder when a recurring charge is declined — is the difference
  between churn and recovered revenue; a subscription business that lacks it loses customers to an
  expired card, not to a decision.
- **Pause / skip / cancel** are table stakes: a subscriber who cannot skip a month cancels instead.
- The threshold: a shop selling only one-off purchases never needs this; the first "subscribe & save"
  offer that ships a plan is what makes the engine earn its place.

## Attachment points in the current core

- **The `Order` aggregate at
  `apps/retail-microservice/src/modules/orders/domain/order.model.ts`.** Each cycle produces a new,
  ordinary `Order` — the immutable placed record, with its three orthogonal status axes (ADR-028 §2).
  The engine is a *producer of orders*, so it attaches to the order aggregate rather than extending
  it; a generated order is indistinguishable from a checkout order once placed.
- **The scheduler pattern at
  `apps/retail-microservice/src/modules/orders/infrastructure/scheduling/`.** The orders module already
  runs timers there — `stale-capture-claim.scheduler.ts` and the idempotency purge — registered via
  `ScheduleModule.forRoot()` in `orders.module.ts`. A subscription due-date sweep is the same shape:
  an infrastructure scheduler that wakes, finds due subscriptions, and drives each through a place-like
  flow.
- **The `PAYMENT_GATEWAY` port** (`application/ports/payment-gateway.port.ts`) — the engine authorizes
  and captures each cycle's charge through the one existing seam, using a stored method token rather
  than a fresh card entry.

## Implementation sketch

- **Aggregate: `Subscription`** — the customer's active enrolment in a plan. It carries the
  `variantId`(s), the chosen cadence, the next-charge date, a stored payment-method token, and the
  pause/skip/cancel state. It is a **mutable** aggregate (unlike `Order`), version-checked with the one
  OCC protocol (`runWithOccRetry`, ADR-045) — never a second retry ladder.
- **A due-date sweep scheduler** under `infrastructure/scheduling/`, cadence and batch size arriving
  through a value-provider token (the `RESERVATION_SWEEP_*` precedent — a use case never reads
  `process.env`). It selects subscriptions whose next-charge date has passed and enqueues each.
- **Each charge resolves price at charge time.** The plan states a *relationship* to the `price`
  ledger, never a snapshot, so the engine reads the active ledger row for the `(variantId, currency)`
  scope *as it stands then* and applies the plan's adjustment. This is the constraint inherited from
  the plan guide — there is no stored amount to trust.
- **The payment retry ladder (dunning)** is a bounded state machine on the `Subscription`: on a
  declined charge, schedule a retry after a back-off, emit a "payment failing" notification, and
  cancel after N failures. It reuses the `PAYMENT_GATEWAY` seam and the capture-claim discipline
  (ADR-052) — the retry never double-charges because the claim is taken before the gateway call.
- **Idempotency:** each cycle's order-generation is a money-moving write and joins the request-level
  idempotency set (ADR-036); the idempotency key is deterministic per `(subscriptionId, cycleNumber)`
  so a re-fired sweep tick cannot mint a duplicate order.
- **Events** ride `ris.events` unchanged — `retail.subscription.created`, `.renewed`, `.paused`,
  `.cancelled`, plus the ordinary `retail.order.placed` for each generated order.

## Open design questions

- **What does a failed final retry do to the order?** If an order was already generated before the
  charge failed, `markPaymentFailed()` + `cancel()` unwinds it (the ADR-052 decline path); if the
  charge is attempted before the order exists, there is nothing to cancel. Which ordering the engine
  uses decides the cleanup story.
- **Proration and mid-cycle plan changes** — upgrading a plan mid-cycle needs a credit/charge
  calculation the one-off order flow has never had.
- **Cadence drift** — does "monthly" mean same-day-of-month (which breaks on the 31st) or every-30-
  days? The plan offers the cadence; the engine has to make it a concrete date arithmetic.
- **Dunning window versus TTL** — how long a failing subscription stays live before cancellation, and
  whether a paused subscription is swept at all.

## Effort sketch

`subsystem-scale (5+ capabilities)` — the `Subscription` aggregate, the due-date sweep, per-cycle order
generation, price resolution at charge time, the dunning ladder, and pause/skip/cancel. It is the
heavier half of the subscription story; the [selling plan](../product-catalog/subscriptions-and-selling-plans.md) is the
lighter catalog-side share, and the two together are why that guide reads subsystem-scale too.
