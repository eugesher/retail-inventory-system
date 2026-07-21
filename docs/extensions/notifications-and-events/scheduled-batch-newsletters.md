---
title: Scheduled batch newsletters
cluster: Notifications & Events
effort: 2–3 capabilities
attaches_to:
  - apps/notification-microservice/src/modules/notifications/infrastructure/scheduling/delivery-retention.scheduler.ts
  - apps/notification-microservice/src/modules/notifications/application/use-cases/send-marketing.use-case.ts
---

# Scheduled batch newsletters

## Description

A **scheduled batch newsletter** is a marketing email composed now and sent later, to many people at
once: the Thursday-morning new-arrivals mail, the seasonal sale announcement. Two things distinguish
it from every send the system does today — it is **scheduled** (a future instant, not a reaction to
an event) and it is **batched** (thousands of recipients from one authored message, rather than one).

This guide owns **scheduling and batching**: when a send fires, how a large run is paced, resumed and
cancelled. It does **not** own who receives it —
[marketing-campaigns-and-segmentation.md](marketing-campaigns-and-segmentation.md) owns audience
resolution, and this guide consumes a resolved audience rather than defining one. The split is worth
stating because it is the natural place for two sketches to quietly grow two answers to "who is in
this send?".

## Business needs

- **Predictable cadence builds an audience** — a newsletter that arrives every Thursday is a habit; an
  irregular one is a surprise, and surprises get unsubscribed.
- **Timing is a real lever** — send-time affects open rate materially, and a marketer composing at
  11pm should not have to be awake at 8am to press send.
- **Working ahead** — seasonal campaigns are written weeks early; a scheduled state is what lets them
  be written once and reviewed before they go.
- **Volume needs pacing** — dispatching fifty thousand emails as fast as the broker allows trips an
  ESP's throttle and damages sender reputation, which is far more expensive than a slow send.
- The threshold: a shop with a handful of subscribers can send by hand; the first recurring send
  large enough to need pacing, or planned far enough ahead to need a schedule, is the trigger.

## Attachment points in the current core

- **`SendMarketingUseCase` at
  `apps/notification-microservice/src/modules/notifications/application/use-cases/send-marketing.use-case.ts`
  — the one-recipient version of this.** It is a thin mapper in front of `RenderAndDispatchUseCase`,
  reached over the `notification.marketing.send` RPC: it fixes the channel to `email`, sets
  `eventReferenceType: 'marketing'` and uses the per-send `campaignId` as the reference id, and lets
  the consent gate decide send versus `skipped-no-consent`. **A batch is this call, paced, over a
  resolved audience.** Its documented failure mode is worth inheriting too: it returns `null` when no
  active marketing template resolves, and that is almost always a **missing seed**, not a missing
  feature — the marketing template is authored by the seed script, not by a migration.
- **The two schedulers in
  `apps/notification-microservice/src/modules/notifications/infrastructure/scheduling/` — and the
  reason they differ.** `delivery-retention.scheduler.ts` uses a declarative `@Cron`
  (`EVERY_DAY_AT_3AM`); its sibling `delivery-retry.scheduler.ts` uses `@Interval`. That is not an
  inconsistency, and the rule it encodes is exactly the one a newsletter scheduler needs: **a fixed
  wall-clock time wants `@Cron`; a cadence that is configured cannot use a decorator at all**, because
  a decorator's argument is evaluated when the class is *defined*, long before DI can resolve an
  injected value — which is why the inventory reservation sweep registers its interval imperatively
  through `SchedulerRegistry` instead. A newsletter's send time is **per-campaign data**, not a
  deployment constant, so it is neither: it is a *due-work query on a tick*, not a timer per send.
  All three schedulers share the shape: the schedule lives in `infrastructure/`, the class holds no
  business logic, and a thrown tick cannot kill the loop.
- **`PurgeAgedDeliveriesUseCase`** — the precedent for **bounded** scheduled work: a nightly tick that
  does a capped amount and leaves the rest for the next one, rather than an unbounded scan. A batch
  send is the same discipline with a different verb.
- **The consent gate inside `RenderAndDispatchUseCase`.** A newsletter's `eventType` is not in
  `TRANSACTIONAL_EVENT_TYPES`, so an email send is gated on `consent.marketingEmail`, which
  `DEFAULT_CONSENT` denies for anyone who never opted in. **The check happens per recipient at
  dispatch, not once at schedule time** — consent can be withdrawn in the hours between scheduling
  and sending, and the gate is the only place that sees the current snapshot. A suppressed recipient
  leaves a terminal `skipped-no-consent` row, which is the audit answer to "why didn't they get it?".
- **The delivery dedupe key.** Customer-facing rows dedupe on template id + `eventReferenceType` +
  `eventReferenceId` + `channel` + `recipientCustomerId`, backed by a generated-column UNIQUE. With
  the campaign id as the reference id, **a resumed or re-run batch cannot double-send** — the
  pre-check collapses the repeat and the UNIQUE collapses a concurrent race. This is what makes
  resumability safe without the batch tracking its own cursor perfectly.
- **`MAX_DELIVERY_ATTEMPTS` and the retry sweeper** — a failed send inside a batch is recorded and
  re-attempted by machinery that already exists; the batch does not need its own retry logic.

## Implementation sketch

- **A `ScheduledSend` record with a due instant and a state** (`draft → scheduled → sending →
  sent | cancelled | failed`). The schedule is *data on the send*, not a registered timer per
  campaign — a timer per campaign leaks on restart and cannot survive a deploy.
- **One tick, a due-work query, bounded batches.** A single scheduler polls for sends whose due
  instant has passed and which are still `scheduled`, claims one, and dispatches a bounded slice of
  its audience per tick, advancing until exhausted. This is the purge sweep's shape and it gives
  restart-resumability for free.
- **Claiming is a compare-and-swap.** Two instances running the same tick must not both send.
  `UPDATE … SET state='sending' WHERE id=? AND state='scheduled'` — the `WHERE` **is** the lock, the
  same mechanism cart conversion uses. A re-entrancy flag guards against overlapping ticks in one
  process; the CAS guards against multiple processes, and only the second problem is the real one.
- **Pace deliberately, from configuration.** A per-tick ceiling and a delay between slices keep the
  send under an ESP's throughput limit. The knob arrives through a DI value-provider token — a use
  case never reads `process.env` — and the `RETENTION_DELIVERY_DAYS` history is the standing warning
  about a validated, defaulted key that nothing reads.
- **Each recipient goes through the existing pipeline**, via the `SendMarketingUseCase` mapping:
  template resolution, render, consent gate, delivery row, dedupe, retry. A batch that called
  `NOTIFIER` directly would skip all six, which is the failure mode worth naming explicitly.
- **Cancellation is honoured between slices, not within one.** A send cancelled mid-run stops at the
  next slice boundary; already-dispatched messages are gone. The UI must say so.
- **Timezone is part of the schedule.** "Thursday 9am" means the marketer's zone or the recipient's,
  and the two produce different sends. Store the instant in UTC (`timezone: 'Z'` is pinned on the
  driver) and keep the authored zone alongside it — a zone-less date string resolves in the Node
  host's local zone, which is exactly the class of bug this repo already guards against elsewhere.
- **Events ride `ris.events`** (`notification.batch.scheduled`, `.completed`) — no new exchange, no
  second broker, and any consumer of them **never rethrows**. **No PII in a payload** (ADR-037): a
  batch event carries the send id and counts, never addresses.
- **Shared types** (the scheduled-send view, its progress) under `libs/contracts/<cluster>/`.

## Open design questions

- **Per-recipient send-time optimisation** — "9am in the recipient's timezone" turns one batch into
  twenty-four staggered ones and changes the due-work query from a single instant into a rolling
  window.
- **How much a send reports while running.** Progress, per-recipient status and a live count are what
  a marketer actually wants; they are also a query over a growing set of delivery rows on the hot
  path, and a materialised counter is a second source of truth.
- **Throttle coordination across concurrent sends.** Two batches running at once can jointly exceed a
  limit each respects alone; a global rate budget is a different mechanism from a per-send pace, and
  it is shared with the campaign fan-out.
- **Preview, test sends and approval.** A newsletter going to the whole list with a broken merge field
  is unrecoverable, so a seed-and-review step is closer to mandatory than optional — and a test send
  must not consume the campaign's dedupe key.
- **Failure semantics for a partially-sent batch.** If a run dies at 60%, resuming is safe (the dedupe
  key protects it) but "sent" is no longer a single fact; whether the state machine models partial
  completion or leans on the delivery rows is undecided.

## Effort sketch

`2–3 capabilities` — a scheduled-send record and state machine, a due-work tick with CAS claiming and
bounded paced slices, and the operator surface to schedule, preview and cancel. It stays bounded
**because** the audience comes from the campaign guide, the per-recipient send is an existing use
case, the scheduler shape (including *when to use `@Cron`, `@Interval`, or neither*) is settled by
three working examples, and the dedupe key makes resumption safe without a perfect cursor. What is
genuinely new is pacing and claiming — the two things that only misbehave at volume.
