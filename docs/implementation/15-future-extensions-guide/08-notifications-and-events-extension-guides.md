# 08 — Notifications & Events extension guides

The eight Notifications & Events guides under [`docs/extensions/`](../../extensions/) sketch how a
business would grow outbound messaging past the universal core. This is the cluster with the **most
seams already in place** — a notifier port with a log-only default binding, a versioned template
registry behind a renderer port, a per-recipient delivery log with a retry ladder, a consent reader
with a write-through cache, and a topic exchange every producer already mirrors onto. That makes the
guides easier to write and the mistake easier to make: several of these attach to a *recorded gap*
rather than to nothing, and the temptation is to restate the gap instead of linking it.

Every consumer, port, token, cache builder and routing key named below was read out of the source
this session. The `@EventPattern` set in particular was **enumerated, not cited** — it is the thing
most often misremembered, and the count that matters is:

**Twelve `@EventPattern` handlers, across seven consumer files.** `return-events` (4:
requested / authorized / received / inspected), `fulfillment-events` (2: shipped / delivered),
`consent-events` (2: `customer.consent.updated` / `customer.erased`), and one each in
`order-events` (placed), `order-cancelled-events`, `refund-events` and `inventory-events`
(`inventory.stock.low`). Ten of the twelve dispatch into `RenderAndDispatchUseCase`; the two consent
handlers drive the cache write-through and eviction instead.

Two facts shape almost every guide here, and both are properties of the code rather than preferences:

**Every existing notification is a reaction to something that happened.** All twelve handlers fire on
a business event. Nothing in the service notices an *absence* — which is why
`abandoned-cart-automation.md` is structurally different from its seven siblings and has to borrow
its shape from the inventory reservation sweep rather than from a sibling consumer.

**The consent gate lives in exactly one place, and classifies by `eventType`, not by channel.** It
sits inside `RenderAndDispatchUseCase` (step 3b), *after* the render and *before* the queued row is
persisted. `TRANSACTIONAL_EVENT_TYPES` is a nine-entry set; an `email` dispatch whose `eventType` is
**not** in it is marketing **by definition**, gated on `consent.marketingEmail`. An `sms` dispatch is
always treated as marketing. `DEFAULT_CONSENT` allows transactional email and denies both marketing
channels, so a customer who never wrote a consent record receives no marketing at all. Consequently
**no guide in this cluster proposes a consent check** — every one of them routes its send through the
pipeline so it inherits the one that exists.

## Where consent is checked, for each marketing-adjacent guide

This is the constraint most easily lost in a campaign sketch, because a campaign *feels* like the
place to filter an audience. It is not — the audience is resolved early and consent is applied late.

| Guide | Marketing? | Where the check happens | What each guide had to say |
| --- | --- | --- | --- |
| [marketing-campaigns-and-segmentation.md](../../extensions/marketing-campaigns-and-segmentation.md) | Always | Per recipient at dispatch, inside `RenderAndDispatchUseCase` — **not** at audience resolution | Pre-filtering the audience is an optimisation; the gate is what makes it *correct*, because consent can be withdrawn between resolution and send. The gate also writes the `skipped-no-consent` row that evidences the suppression. |
| [scheduled-batch-newsletters.md](../../extensions/scheduled-batch-newsletters.md) | Always | Per recipient at dispatch, per slice — **not** once at schedule time | Hours can pass between scheduling and sending; only the gate sees the current snapshot. |
| [abandoned-cart-automation.md](../../extensions/abandoned-cart-automation.md) | Yes — its `eventType` is outside `TRANSACTIONAL_EVENT_TYPES` | The same gate, via a consumer that maps to the shared pipeline | A reminder is *not* transactional despite feeling operational; it is gated on `marketingEmail`, which defaults to denied. |
| [push-device-token-registration.md](../../extensions/push-device-token-registration.md) | Depends on `eventType` | The same gate — but **there is no `marketingPush` flag today** | The consent snapshot carries `transactionalEmail` / `marketingEmail` / `marketingSms` and nothing else. Push needs the model *extended*, not borrowed: reusing `marketingEmail` would mean an email opt-in silently became a push opt-in. |
| [in-app-inbox-feed.md](../../extensions/in-app-inbox-feed.md) | Depends on `eventType` | The same gate, unchanged | Classification is by `eventType`, not channel, so a promotional inbox card is gated exactly like a promotional email — correct, and free. |
| [ab-template-testing.md](../../extensions/ab-template-testing.md) | Inherited | Untouched — variant selection replaces the template *resolution* only | Everything downstream of step 1 (render, gate, delivery row, dedupe, retry) is unmodified by a test. |

Three further points the guides carry rather than assume. The consent read is cache-aside under
`CACHE_KEYS.notificationsConsent(customerId)`, kept fresh by the write-through/evict consumer pair,
with `NOTIFICATIONS_CONSENT_CACHE_TTL_SECONDS` (Joi default 300) as a staleness bound rather than the
freshness mechanism — the env var name differs from its DI token, `CONSENT_CACHE_TTL_SECONDS`. The
cache is **fail-safe by contract**: it never throws, falling back to the reader and then to the
defaults, so an outage suppresses marketing rather than leaking it. And a **null-recipient** dispatch
— the low-stock alert to the ops mailbox — skips the gate entirely and is never deduped.

## Outbound webhooks versus the internal bus

The distinction is the whole point of
[webhook-subscription-management-ui.md](../../extensions/webhook-subscription-management-ui.md), and
the guide leads with it because "outbound webhooks are just another consumer of `ris.events`" is both
the obvious framing and wrong.

`EXCHANGES.RIS_EVENTS_TOPIC` (`ris.events`) is the one live exchange; every producer mirrors onto it
through the shared best-effort publisher, so the whole firehose is available from a single binding.
A webhook dispatcher *is* one more consumer of that exchange — the guide is explicit that it must not
become a second exchange or a second broker. What changes is everything on the far side of the
consumer:

| | The internal bus | An outbound webhook |
| --- | --- | --- |
| **Destination** | a queue we operate | a URL a stranger controls |
| **Availability** | a dependency we run | may be down for a week |
| **Failure** | at-least-once redelivery, absorbed by idempotent ingest | ours to retry, back off, and eventually give up |
| **Contents** | internal payloads that change with refactors | a versioned public contract |
| **Security** | none needed on the wire | HMAC signing, secret rotation, SSRF defence |

What that costs, concretely:

- **A separate, much longer retry horizon.** `MAX_DELIVERY_ATTEMPTS` defaults to 3 — calibrated for a
  mail transport, far too tight for a partner endpoint that is down for a day. It needs its own DI
  token, and a bounded run of failures must end in **automatically deactivating** the subscription,
  or a dead endpoint is retried forever.
- **Consumption must be decoupled from dispatch.** If the `#`-bound consumer performs the HTTP call,
  one slow partner stalls every other subscriber. This is the guide's single most important
  structural claim.
- **The payload becomes a contract you cannot refactor.** Internal event payloads move freely; a
  published one does not. The catalogue of publishable event types becomes a surface — and a
  *reserved* internal routing key with no business consumer is the trap, because it looks unused and
  therefore free.
- **SSRF is a first-order concern.** A subscriber-supplied URL is an outbound request from inside the
  network, re-validated at dispatch and after redirects, because DNS can be re-pointed after
  registration passed.
- **PII discipline gets sharper, not softer.** Internal events already carry ids rather than personal
  data (ADR-037); a webhook body that "helpfully" enriches with an email address is an exfiltration
  path to a third-party URL.

The guide also inherits two mechanical details from `FirehoseConsumer` rather than rediscovering
them: the binding is a **lone `#`, never `#.#`** (Nest's `matchRmqPattern` only treats `#` as
match-all when it is the final segment, so `#.#` gets nacked as unsupported), and the handler
**never rethrows**, because an exception from an `@EventPattern` makes the broker blind-redeliver in
a hot loop.

## The eight guides

### [marketing-campaigns-and-segmentation.md](../../extensions/marketing-campaigns-and-segmentation.md)

- **Claim.** Owns **audience resolution** for the cluster. A `Campaign` aggregate over a *dated,
  snapshotted* recipient list — resolution is a snapshot rather than a live query, because a dynamic
  segment evaluated twice yields different people and makes "who received this?" unanswerable.
  `subsystem-scale`.
- **Attaches to.** `consent-reader.port.ts`, `consent-cache.port.ts`,
  `notification-delivery.model.ts`.
- **Inherits.** The segment from `customer-segments-and-tiers.md` (05), which had already stated that
  a later marketing capability reads membership and does not re-invent the grouping. Also the
  existing single-recipient `SendMarketingUseCase`, which a campaign fans out.
- **Links.** `customer-segments-and-tiers.md`, `scheduled-batch-newsletters.md`.

### [scheduled-batch-newsletters.md](../../extensions/scheduled-batch-newsletters.md)

- **Claim.** Owns **scheduling and pacing**, explicitly *not* audience. A due-work tick with
  compare-and-swap claiming and bounded paced slices; the schedule is data on the send, never a
  registered timer per campaign (which leaks on restart).
- **Attaches to.** `delivery-retention.scheduler.ts`, `send-marketing.use-case.ts`.
- **The useful find.** The two schedulers in one folder differ deliberately — `@Cron` for a fixed
  wall-clock time, `@Interval` for a fixed cadence, and **neither** when the cadence is *configured*,
  because a decorator's argument is evaluated at class-definition time before DI can resolve
  anything (which is why the inventory sweep uses `SchedulerRegistry` imperatively). A newsletter's
  send time is per-campaign data, so it is a due-work query, not a timer.
- **Links.** `marketing-campaigns-and-segmentation.md`.

### [abandoned-cart-automation.md](../../extensions/abandoned-cart-automation.md)

- **Claim.** The one notification triggered by an **absence** — a bounded detection sweep over
  `active` carts stale by `updatedAt`, emitting an event the notification service consumes.
- **Attaches to.** `cart.model.ts`, `reservation-sweep.scheduler.ts`.
- **The trap it had to avoid.** `CartStatusEnum.ABANDONED` **already exists and means something
  else**: its documented contract states there is no stale-cart purge and no timer that abandons
  anything, and that its sole producer is **customer erasure**. Reusing the member would conflate a
  privacy tombstone with a marketing opportunity — and mean emailing erased customers. The guide
  tracks reminder progress on a companion record and leaves the status alone; as a bonus, the
  `active`-only candidate query excludes erased customers' carts for free.
- **Links.** None.

### [ab-template-testing.md](../../extensions/ab-template-testing.md)

- **Claim.** A variant dimension on the template registry key, deterministic per-recipient assignment
  at the single resolution call site, and promotion via an ordinary registry edit.
- **Attaches to.** `notification-template.model.ts`, `template-renderer.port.ts`.
- **The rail.** An A/B test varies the **template**, never the **renderer**: exactly one file imports
  the templating library, behind `TEMPLATE_RENDERER`. The registry is the seam that bends — it
  already holds many versioned rows per `(eventType, channel, locale)` key and already picks the
  highest-version active one; a test makes that choice per recipient. The guide is honest that the
  *measurement* half depends on delivery outcomes the core does not ingest.
- **Links.** The root `README.md`'s `Not built yet` section (twice — locale resolution, and the ESP
  webhook ingestion behind the outcome RPC).

### [in-app-inbox-feed.md](../../extensions/in-app-inbox-feed.md)

- **Claim.** A channel whose delivery is a **read**, not a send. An adapter behind `NOTIFIER` whose
  `send` writes a row and returns, plus read-state kept beside the message rather than in its status.
- **Attaches to.** `notification-delivery.model.ts`, `notifier.port.ts`.
- **The sharp constraint.** A delivery row is never soft-deleted (`deletedAt` is inert, because a
  hidden row breaks the dedupe query) but **is** hard-deleted at the `RETENTION_DELIVERY_DAYS`
  horizon by a nightly bounded purge. An audit log pruned at 90 days is fine; a customer's message
  history vanishing at 90 days is a product decision nobody made. The guide calls this the most
  likely defect in the capability, and it would surface months after release.
- **Links.** `push-device-token-registration.md`, `live-customer-messaging.md`, the `Not built yet`
  section.

### [push-device-token-registration.md](../../extensions/push-device-token-registration.md)

- **Claim.** The **token registry**, not the transport. A customer-owned `DeviceToken` with
  owner-checked registration, reassignment across accounts, and permanent-versus-transient failure
  classification that retires dead tokens.
- **Attaches to.** `customer.model.ts`, `notifier.port.ts`.
- **Erasure.** Tombstone erasure nulls PII *in place* because the row must survive for referential
  integrity — an order points at its customer. A device token has no such dependant, so the guide's
  answer is **delete the rows**, driven off the existing `customer.erased` event (already consumed by
  this service to evict the consent cache), in a consumer that never rethrows.
- **Also.** The one guide that needs the **consent model extended** — there is no `marketingPush`
  flag, and borrowing `marketingEmail` would turn an email opt-in into a push opt-in.
- **Links.** `in-app-inbox-feed.md`, the `Not built yet` section.

### [webhook-subscription-management-ui.md](../../extensions/webhook-subscription-management-ui.md)

- **Claim.** Calling **outward**. A `#`-bound consumer matching routing keys against subscriptions,
  decoupled from a dispatch worker with its own long retry horizon, signing, SSRF defence, and replay
  from `domain_event`.
- **Attaches to.** `exchanges.constants.ts`, `firehose.consumer.ts`.
- **Links.** The `Not built yet` section (twice — the webhook notifier transport, and the ESP
  ingestion RPC that has no HTTP route).

### [live-customer-messaging.md](../../extensions/live-customer-messaging.md)

- **Claim.** The cluster's only **new deployable**. Everything the notification service does is
  fire-and-forget, one-way and stateless per message; live chat is bidirectional, stateful and
  connection-oriented. Those are opposite operational shapes, and a socket-bearing process is scaled
  and drained differently from an RMQ consumer. `subsystem-scale`.
- **Attaches to.** `apps/api-gateway/src/modules` (the shape precedent — the `auth`-shaped case: a
  module with ports, use cases, messaging, presentation *and* real `domain/` state) and
  `apps/notification-microservice/src/modules/notifications` (what it must not duplicate).
- **The narrow reuse.** The overlap with the notification service is smaller than it looks; the one
  seam worth reusing is the **follow-up email** for an unanswered conversation, which is an ordinary
  templated notification and goes through the existing pipeline.
- **The rail most at risk.** Cross-instance fan-out rides `ris.events` and carries **ids only** — the
  message body stays in the database, even though putting it in the event is the obvious way to make
  relay cheap.
- **Links.** `in-app-inbox-feed.md`, the `Not built yet` section.

## Ledger rows these guides cite

ADR-055's rule is that a row and a guide may cover the same ground, but the row names the seam and
the guide describes the capability — **neither restates the other**. Four guides link the root
[`README.md` § Not built yet](../../README.md#14-not-built-yet) section (never a row's text):

| Row | Cited by | Why |
| --- | --- | --- |
| *Email / webhook notifier transports* — `NOTIFIER` port; `LogNotifierAdapter` is the default binding | `push-device-token-registration.md`, `in-app-inbox-feed.md`, `webhook-subscription-management-ui.md` | Each proposes a new adapter behind that unchanged port. |
| *ESP webhook ingestion* — `notification.delivery.record-outcome` RPC, no HTTP route | `ab-template-testing.md`, `webhook-subscription-management-ui.md` | A/B measurement needs the outcomes it would carry; the webhook guide notes it as the mirror-image inbound capability. |
| *Locale resolution* — producer events ship `customerLocale: null` | `ab-template-testing.md` | Locale is already part of the template registry key, so a variant that differs by locale would measure the gap rather than the copy. |
| *Staff deactivation / password reset* | `live-customer-messaging.md` | A departing agent holding open conversations is where that gap bites. |

**One row was deliberately not cited.** The *delivery-row purge worker* row — the retention knob
described as "validated but unread" — looks like a natural anchor and is **stale**. `README.md` still
says `RETENTION_DELIVERY_DAYS` is Joi-validated and nothing reads it, but the code has
`PurgeAgedDeliveriesUseCase`, `DeliveryRetentionScheduler` (`@Cron`, `EVERY_DAY_AT_3AM`) and the
`RETENTION_DELIVERY_DAYS` DI token all wired in `notifications.module.ts`. The purge is built. So
`in-app-inbox-feed.md` treats the 90-day horizon as a **live constraint on reusing the delivery
table** — which is what it now is — rather than citing a gap that has closed. Correcting the row
itself belongs with the next revision of `README.md` §14, not here; no guide links to it, so nothing
propagates the claim.

## Cross-links and ownership, this cluster

- **Audience resolution belongs to `marketing-campaigns-and-segmentation.md`**; scheduling and pacing
  belong to `scheduled-batch-newsletters.md`. They link each other, and the newsletter guide states
  the split in its Description so the two cannot quietly grow two answers to "who is in this send?".
- **`in-app-inbox-feed.md` and `push-device-token-registration.md`** each carry exactly one sentence
  acknowledging that they are two channels behind the same `NOTIFIER` port — push carries a message
  *out* to a device, an inbox holds it *until* fetched — and neither re-derives the other's transport.
- **The segment is inherited, not redefined.** `customer-segments-and-tiers.md` had already named a
  future marketing capability as a consumer; this cluster is the second to lift that seam — the
  Pricing & Promotions guides were the first.
- Every link points **backward** — to a guide from an earlier session, to a guide written earlier in
  this one, or to the root `README.md` section. Nothing in this cluster links forward.
