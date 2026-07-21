---
title: Abandoned-cart automation
cluster: Notifications & Events
effort: 2–3 capabilities
attaches_to:
  - apps/retail-microservice/src/modules/cart/domain/cart.model.ts
  - apps/inventory-microservice/src/modules/stock/infrastructure/scheduling/reservation-sweep.scheduler.ts
---

# Abandoned-cart automation

## Description

**Abandoned-cart automation** notices that a shopper filled a cart and never checked out, and emails
them about it — usually a sequence: a reminder after an hour, a nudge after a day, sometimes a
discount after three. It is consistently among the highest-ROI messages an online shop sends, because
the recipient already chose the products.

It is also the cluster's clearest example of a notification triggered by an **absence**. Every one of
the twelve `@EventPattern` handlers in the notification service today fires because something
*happened* — an order was placed, a shipment moved, a refund was issued, a return was inspected.
Nothing happened here. A cart sitting untouched emits no event, so this capability needs a **timer
that looks for silence**, which is a different shape from every consumer the service currently has.

## Business needs

- **Recovered revenue on carts already built** — the shopper has already made the hard choices; a
  reminder converts a meaningful fraction of otherwise-lost baskets.
- **Diagnosing checkout friction** — a spike in abandonment at a particular step is a product signal,
  and the data that drives the reminder is the same data that surfaces it.
- **Held stock is a real cost** — an abandoned cart with live reservations withholds inventory from
  buyers who would complete; prompting the shopper resolves that either way.
- The threshold: a shop with a short, single-page checkout and low volume will not recover enough to
  justify a timer and a sequence; sustained cart volume with a measurable drop-off is where it starts
  paying.

## Attachment points in the current core

- **`Cart` at `apps/retail-microservice/src/modules/cart/domain/cart.model.ts`, and the trap in
  `CartStatusEnum`.** The status enum already has an `ABANDONED` member — and it **does not mean what
  this capability means**. Its documented contract is explicit: `ABANDONED` has exactly one producer,
  **customer erasure** (ADR-037), applied in raw SQL; there is **no stale-cart purge and no timer
  that abandons anything**, so an abandoned cart in this system means an *erased customer*, not a
  forgotten shopper. Reusing the member would conflate a privacy tombstone with a marketing
  opportunity — and would mean emailing erased customers. **A "stale but live" cart is a distinct
  concept and needs a distinct one**: either a new status, or a derived condition that leaves the
  status alone. The latter is safer, because both existing terminal transitions are one-way.
- **`Cart.updatedAt` and `Cart.expiresAt`.** `updatedAt` is the staleness signal — how long since the
  shopper last touched the cart — and `expiresAt` is already on the aggregate (nullable). A candidate
  query is "`status = 'active'` and `updatedAt` older than the threshold", which is an indexable
  predicate over columns that already exist.
- **`ReservationSweepScheduler` at
  `apps/inventory-microservice/src/modules/stock/infrastructure/scheduling/reservation-sweep.scheduler.ts`
  — the precedent for a timer that notices absence.** It is the closest existing analogue and worth
  copying in detail: the schedule lives in `infrastructure/`, never in a use case; the class holds no
  business logic, only *when*; a thrown tick cannot kill the loop; a re-entrancy flag skips an
  overlapping tick rather than racing itself; the cadence is injected, which is *why* the interval is
  registered imperatively through `SchedulerRegistry` rather than declared by a decorator (a
  decorator's argument is evaluated at class-definition time, before DI can resolve anything). And it
  **must** delete its interval on destroy or a leaked timer hangs the test worker.
  The sweep's use case is also the precedent for the **bounded batch** — a candidate query with a
  ceiling, not an unbounded scan.
- **The consent gate inside `RenderAndDispatchUseCase`.** An abandoned-cart email is **marketing**,
  not transactional: its `eventType` will not be in `TRANSACTIONAL_EVENT_TYPES`, so the gate weighs it
  against `consent.marketingEmail`, which `DEFAULT_CONSENT` denies. That is the correct default and
  the correct place — the reminder must be dispatched *through* the pipeline so the gate applies, and
  a suppressed one leaves a `skipped-no-consent` row rather than vanishing.
- **The delivery dedupe key.** With `eventReferenceType: 'cart'` and the cart id as the reference id,
  the generated-column UNIQUE stops a second tick re-sending the same reminder — the sequence's
  "send once per stage" property comes free, provided each stage is a distinct `eventType`.

## Implementation sketch

- **Detect by query on a timer, not by event.** A scheduled sweep selects `active` carts whose
  `updatedAt` is older than the threshold and which have at least one line, in bounded batches — the
  reservation-sweep shape. Nothing about the cart aggregate changes; the timer reads a condition.
- **Leave `CartStatusEnum` alone.** Track reminder progress on a small companion record (cart id,
  stage, sent-at) rather than a status transition. The cart stays `active` because it *is* — the
  shopper can still check out, which is the entire point of the reminder. This also keeps erasure's
  sole ownership of `ABANDONED` intact.
- **The sweep emits; it does not send.** The retail service publishes `retail.cart.abandoned` (a
  dotted key on `ris.events`, mirrored by the shared publisher) and the notification service consumes
  it in a new consumer alongside the existing seven — reusing the established producer/consumer
  split rather than having retail dispatch mail. The consumer maps to `RenderAndDispatchUseCase` like
  every other one, and **never rethrows**: a failure is recorded on the delivery row and re-attempted
  by the existing retry sweeper, because a rethrow blind-redelivers in a hot loop.
- **A sequence is several stages, each its own `eventType` and template.** `cart.abandoned.1h`,
  `.24h`, `.72h` are three registry keys, three templates, three dedupe scopes — no new state machine.
  The stage record is what stops a later stage firing after conversion.
- **Cancellation is a read, not a race.** Before dispatching, re-check the cart is still `active`;
  the conversion path flips it to `converted` with a compare-and-swap in raw SQL, so a cart that was
  placed between detection and send fails that check. Under at-least-once delivery the dedupe key is
  the second line of defence.
- **No PII in the event** (ADR-037): `retail.cart.abandoned` carries the cart id, the customer id and
  line ids — the consumer resolves the address the same way the existing consumers do. A cart whose
  customer was erased must not produce a reminder at all; the erasure path already flips such carts to
  `ABANDONED`, which the `active`-only candidate query excludes for free.
- **Shared types** (the abandoned-cart event, the reminder stage view) under `libs/contracts/<cluster>/`.

## Open design questions

- **Where the timer lives.** Retail owns the cart, so the detection sweep belongs there; but the
  notification service owns every other scheduler in this area. Putting it in retail keeps the
  candidate query next to its tables and keeps the event-driven boundary intact — at the cost of a
  fourth service running a timer.
- **The staleness threshold, and whether it is configurable.** If it is, it arrives through a DI
  value-provider token like every other tunable, never `process.env` in a use case — and the
  `RETENTION_DELIVERY_DAYS` history is the warning about a validated key nothing reads.
- **Guest carts.** A cart without a customer id has no consent record and often no address; whether
  an emailed guest checkout is in scope decides whether this capability depends on capturing an
  address before checkout completes.
- **Interaction with reservation TTL.** Reservations expire on their own sweep, so by the time a
  72-hour reminder lands the held stock is long released and the cart may no longer be fulfillable at
  the snapshotted price. Whether the reminder re-validates availability, or is deliberately
  optimistic, changes its usefulness.
- **Frequency interaction with campaigns** — an abandoned-cart sequence plus a newsletter can easily
  put four emails in a week in front of one person; the cap belongs with the campaign machinery, not
  duplicated here.

## Effort sketch

`2–3 capabilities` — a bounded detection sweep on a timer, a reminder-stage record and its event, and
a consumer wired into the existing dispatch pipeline. It stays bounded **because** the timer shape is
already established by the reservation sweep down to the re-entrancy guard and the destroy hook, the
staleness signal is a column that already exists, and consent, dedupe, retry and the delivery row are
all inherited from the pipeline. The one thing that cannot be inherited is the `ABANDONED` status,
which already belongs to something else.
