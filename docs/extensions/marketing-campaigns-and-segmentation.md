---
title: Marketing campaigns and segmentation
cluster: Notifications & Events
effort: subsystem-scale (5+ capabilities)
attaches_to:
  - apps/notification-microservice/src/modules/notifications/application/ports/consent-reader.port.ts
  - apps/notification-microservice/src/modules/notifications/application/ports/consent-cache.port.ts
  - apps/notification-microservice/src/modules/notifications/domain/notification-delivery.model.ts
---

# Marketing campaigns and segmentation

## Description

A **campaign** is a marketing message sent to a *chosen audience* rather than to the one customer a
business event happened to. "Email everyone who bought a grill last summer but no fuel this year"
is a campaign; "email the person whose order just shipped" is not. Klaviyo, Braze, Mailchimp and
Shopify Email all model the same three parts: an **audience** (who), a **campaign** (what and when),
and **per-recipient delivery tracking** (what happened to each one).

This guide **owns audience resolution** for the whole Notifications cluster — the question *"which
customers receive this send, and as of when?"*. [scheduled-batch-newsletters.md](scheduled-batch-newsletters.md)
owns the *scheduling and batching* of a large send and links here for its audience rather than
re-deriving one. The **segment** itself is not defined here either: it is defined in
[customer-segments-and-tiers.md](customer-segments-and-tiers.md), which already states that a later
marketing capability reads membership and does not re-invent the grouping. This guide consumes that
segment and adds resolution, campaign lifecycle and per-recipient tracking on top.

The system already has the *single-recipient* end of this. `SendMarketingUseCase` is a staff-triggered
marketing dispatch behind the `notification.marketing.send` RPC: it names one customer and one
marketing `eventType`, maps to the `email` channel with `eventReferenceType: 'marketing'` and the
`campaignId` as the reference id, and lets the consent gate decide. A campaign is what turns that one
recipient into a resolved, tracked audience.

## Business needs

- **Reaching a cohort is the point of marketing** — the value of a shop's customer list is that it can
  be addressed selectively; a broadcast to everyone is the version that gets a domain blocklisted.
- **Campaign attribution** — a business needs to know which send drove which orders, which requires a
  durable campaign identity carried from the send through to the resulting purchase.
- **Frequency capping and suppression** — a customer who received three emails this week should not
  receive a fourth; suppression lists (bounced, complained, unsubscribed) must survive campaigns.
- **Auditable consent posture** — a regulator asking "why did this person receive this?" needs an
  answer per recipient, not per campaign.
- The threshold: a shop whose only outbound mail is transactional needs none of this; the first
  "send this offer to lapsed customers" is where an audience must become a resolved, recorded thing.

## Attachment points in the current core

- **The consent gate inside `RenderAndDispatchUseCase`** (step 3b, after the render and *before* the
  queued row is persisted). It reads the recipient's snapshot through `CONSENT_CACHE` and classifies
  the dispatch with `TRANSACTIONAL_EVENT_TYPES`: an `email` whose `eventType` is **not** in that
  nine-entry set is **marketing by definition** and is gated on `consent.marketingEmail`; an `sms`
  dispatch is always treated as marketing (`consent.marketingSms`). `DEFAULT_CONSENT` denies both
  marketing channels for a customer who has never written a record. **A campaign therefore does not
  need to build a consent check — it must route every send through this pipeline so it inherits one.**
- **`CONSENT_READER` / `CONSENT_CACHE` at
  `apps/notification-microservice/src/modules/notifications/application/ports/consent-reader.port.ts`
  and `consent-cache.port.ts`.** The reader is parameterized SQL over the shared `consent_record`
  table (never importing the gateway's entity); the cache is cache-aside under
  `CACHE_KEYS.notificationsConsent(customerId)`, kept fresh by a write-through on
  `customer.consent.updated` and an eviction on `customer.erased`, with
  `NOTIFICATIONS_CONSENT_CACHE_TTL_SECONDS` as a staleness bound rather than the freshness mechanism.
  The cache is **fail-safe by contract** — it never throws, falling back to the reader and then to
  the defaults, so a Redis hiccup suppresses marketing rather than leaking it.
- **`NotificationDelivery` at
  `apps/notification-microservice/src/modules/notifications/domain/notification-delivery.model.ts`.**
  Per-recipient tracking already exists: one row per send, carrying `status`, `attemptCount`,
  `failureReason` and the rendered body, with a terminal `SKIPPED_NO_CONSENT` status recording what
  *would* have been sent. A campaign's per-recipient report is a query over these rows keyed on
  `eventReferenceType = 'marketing'` and the campaign id — no new tracking table.
- **The delivery dedupe key.** Customer-facing rows dedupe on template id + `eventReferenceType` +
  `eventReferenceId` + `channel` + `recipientCustomerId`, enforced by a generated-column UNIQUE. With
  the campaign id as the reference id, **a redelivered or re-run campaign cannot double-send to the
  same customer** — the pre-check collapses it and the UNIQUE collapses a concurrent race.
- **`SendMarketingUseCase`** — the existing single-recipient marketing path this capability fans out.

## Implementation sketch

- **Aggregate: `Campaign`** — identity, the marketing `eventType` (the template key), the target
  segment reference, a lifecycle (`draft → scheduled → sending → sent | cancelled`), and the send
  window. The `campaignId` it mints is already the reference id the existing marketing path expects.
- **Audience resolution is a snapshot, not a live query.** Resolving a segment produces a dated,
  persisted **recipient list** for that campaign. Two reasons: a dynamic segment evaluated twice
  yields different people, which makes "who received this?" unanswerable; and a long send must be
  resumable without re-evaluating a moving target. The snapshot is the audit answer.
- **Consent is applied per recipient at dispatch, not at resolution.** Filtering the audience up
  front looks cheaper but is wrong: consent can be withdrawn between resolution and send, and the
  gate inside Render & Dispatch is the only place that sees the current snapshot. Resolution may
  pre-filter as an optimisation; **the gate is what makes it correct**, and it also produces the
  `skipped-no-consent` row that evidences the suppression.
- **Fan-out is chunked and drives the existing pipeline.** A send walks the snapshot in bounded
  batches and calls the same `RenderAndDispatchUseCase` per recipient — inheriting the template
  resolution, the consent gate, the dedupe key, the delivery row and the retry ladder. A campaign
  that called `NOTIFIER` directly would skip all five.
- **Suppression and frequency capping sit in front of resolution.** A suppression list (hard bounces,
  complaints, unsubscribes) is a separate, permanent exclusion distinct from consent — consent is
  what the customer chose, suppression is what the transport reported. Frequency caps read the
  delivery rows already written.
- **A failed send is recorded, never rethrown.** If a campaign is driven from an event handler, a
  thrown error blind-redelivers under at-least-once RMQ; the delivery row's `FAILED` status plus the
  existing retry sweeper (capped at `MAX_DELIVERY_ATTEMPTS`) is the answer already modelled.
- **Events ride `ris.events`** with dotted routing keys (`notification.campaign.scheduled`,
  `.sent`) — mirrored by the shared publisher onto the one live topic exchange, no second broker.
  **No PII in a payload** (ADR-037): a campaign event carries ids and counts, never an address.
- **Shared types** (the campaign view, the audience snapshot) under `libs/contracts/<cluster>/`; any
  cached read names a `CACHE_KEYS` builder, never a key literal.

## Open design questions

- **Where the campaign aggregate lives.** The notification service owns sending; the segment is
  gateway-adjacent customer data. A campaign that lives in notifications must read segment membership
  across a context boundary (the `CONSENT_READER` parameterized-SQL precedent), while one that lives
  at the gateway must drive sends over RPC. Neither is free.
- **Snapshot size and storage.** A million-recipient audience is a million rows per campaign; whether
  the snapshot is materialised, or is a recorded *rule plus evaluation timestamp* replayed
  deterministically, is a scale trade with an auditability cost.
- **Unsubscribe granularity.** Today consent is per channel (`marketingEmail` / `marketingSms`).
  Per-campaign or per-topic unsubscribe ("stop sending me restock alerts, keep the newsletter") is a
  richer consent model, and it belongs on `ConsentRecord`, not in the campaign.
- **Attribution windows** — how long after a send an order counts as driven by it, and what carries
  the campaign id through the cart to the order.
- **Rate limiting to protect sender reputation** — a fan-out that dispatches as fast as the broker
  allows will trip an ESP's throttle; where the pacing lives (campaign, transport, or the batch
  scheduler this guide shares with the newsletter guide) is undecided.

## Effort sketch

`subsystem-scale (5+ capabilities)` — a campaign aggregate and lifecycle, audience resolution and
snapshotting over the segment model, chunked fan-out, suppression and frequency capping, and
per-campaign reporting, each a capability on its own. What keeps it from being larger is that the
hardest correctness properties are already built and inherited rather than rebuilt: the consent gate,
the per-recipient delivery row, the dedupe key that prevents a double-send, and the retry ladder. The
work is audience and orchestration, not delivery.
