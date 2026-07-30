# The render-and-dispatch pipeline

This document introduces **`RenderAndDispatchUseCase`** — the single pipeline that turns a
business event into an outgoing notification. It loads the live template, renders the
subject/body, persists a `NotificationDelivery` row in `queued` **before** any transport
call, dispatches through the `NOTIFIER` port, then flips the row to `sent` or `failed`.
Every event consumer ultimately calls this one use case; the consumers themselves (the
translation from a specific wire event to the pipeline's input) are now all wired onto it —
each is a thin translator that maps its wire event onto the pipeline's input and delegates.

The foundations this builds on are covered next door: the
[`NotificationTemplate` registry](01-notification-template-versioning.md), the
[`NotificationDelivery` audit trail](02-notification-delivery-as-audit-trail.md), and the
[Handlebars renderer](05-handlebars-renderer-choice.md). It honors
[ADR-033](../../adr/033-notification-templates-deliveries-and-render-dispatch.md) (the
persist-then-send ordering + the database dedupe) and
[ADR-011](../../adr/011-notifier-port-and-adapters.md) (the one-method `NOTIFIER` port is
preserved; the rendered content threads through the existing `Notification` value object).

## 1. The consumer-callback shape: event → `IRenderAndDispatchInput`

The use case is **channel- and event-agnostic**. It never imports a wire-event type and
never knows whether it is sending an order confirmation or a low-stock alert. The consumer
owns that knowledge and reduces its specific event to one channel-agnostic input:

```ts
export interface IRenderAndDispatchInput {
  eventType: string;                  // the template key's first component, e.g. 'retail.order.placed'
  channel: NotificationChannelEnum;   // EMAIL this capability
  locale?: string;                    // defaults to 'en-US'
  recipientCustomerId: string | null; // null for system/ops notifications
  recipientAddress: string;           // the resolved email (customer email or the ops mailbox)
  eventReferenceType: string;         // 'order' | 'return-request' | 'stock-low' | 'fulfillment' | 'refund' | 'marketing'
  eventReferenceId: string;
  context: Record<string, unknown>;   // the render context (the event's fields)
  correlationId: string;
}
```

Splitting the work this way keeps the registry resolution, rendering, persistence,
idempotency, and dispatch in **one** place regardless of which of the (eventually) many
consumers triggered it. A consumer's only job is the mapping — which event field is the
recipient address, which is the reference id, what the render context should contain.

`eventType` doubles as the **null-subject transport fallback** (§6).

## 2. The pipeline, in order

```
locale = input.locale ?? 'en-US'
template = templateRepo.findLatestActive(eventType, channel, locale)
  └─ none?  → warn, return null  (no row persisted — §7)
renderedSubject = template.subject ? renderer.render(subject, context) : null
renderedBody    = renderer.render(body, context)
  ├─ throws?      → warn, return null  (a malformed staff-authored template — §7)
  └─ empty body?  → warn, return null  (same treatment — §7)
if recipientCustomerId !== null:                            ◀── customer-facing only
  dedupe pre-check → existing row? → return it, no dispatch  (§5)
  consent gate     → unconsented?  → save NotificationDelivery.skipped(…), return it, no dispatch
delivery = NotificationDelivery.open({ status: queued, … }) → deliveryRepo.save(delivery)   ◀── PERSIST
  └─ saved row not `queued`? → the race-loser's view of the winner's row → return, no dispatch  (§5)
notifier.send(new Notification({ recipient, channel, subject, body, metadata }))            ◀── DISPATCH
  ├─ ok    → delivery.markSent(now)
  └─ throw → delivery.markFailed(now, reason)   (NOT rethrown — §4)
deliveryRepo.save(delivery)
return delivery
```

The order of the two marked steps — **persist, then dispatch** — is the whole point.

Two of those branches arrived after this document was first written and are called out
where they belong: the **consent gate** is
[ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md)'s (§5a below), and the
**render-failure / empty-body** guards extend §7's missing-template reasoning to a template
that resolves but cannot produce a message.

## 3. Why persist-before-dispatch

The `queued` row is written to the database **before** the `NOTIFIER` is called. If the
process crashes between the two — after the row commits but before (or during) the send —
the row survives in `queued`, and the retry sweeper re-attempts it — see the
[retry document](06-retry-and-failure-events.md) §1a, which covers how such an **orphaned**
row is found and why the rule is an age rather than a status.

That was not always true, and the history is worth one sentence, because it is what the
whole persist-then-send trade depends on: for a long time `listRetryable` scanned
`status = failed` alone and the manual retry refused anything that was not `failed`, so a row
stranded in `queued` was reachable by **no** path at all. The order below bought an audit row
nobody could act on. Both paths now accept an orphan.

The inverse order (send first, then record the outcome) has a silent-loss window: a crash
after the send but before the write leaves an email in the customer's inbox with **no**
audit row — the system believes it never sent. Persisting first trades a rare
double-send (a `queued` row whose send actually succeeded but whose status write was lost,
later re-attempted) for never losing the audit trail. For notifications, a possible
duplicate is far cheaper than a possible silent drop — and the database dedupe (§5) caps
the duplicate.

This mirrors the order-placement decision elsewhere in the system: stock is allocated
*before* the payment is authorized, so money is never taken for stock that cannot be
fulfilled. The audit-bearing write goes first.

## 4. Failure handling: record, don't rethrow

A thrown `NOTIFIER` is **caught, recorded, and swallowed** — never rethrown:

```ts
try {
  await notifier.send(notification);
  delivery.markSent(now);
} catch (err) {
  delivery.markFailed(now, err.message); // attemptCount += 1, failureReason recorded
}
await deliveryRepo.save(delivery);
```

Rethrowing would defeat two things. First, it would discard the value of the row we just
persisted — the failure is *captured* on the row (`status = failed`, `failureReason`,
`attemptCount = 1`, `lastAttemptAt`), which is exactly what the retry sweeper scans for.
Second, these consumers run inside `@EventPattern` handlers over RabbitMQ
([ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)); an exception there triggers a
**blind redelivery** of the whole event, re-running template resolution and rendering from
scratch, rather than the **targeted, capped** re-attempt the `failed` row enables. Recording
the failure on the row is the more precise recovery mechanism.

`attemptCount` is monotonic (only `markSent` / `markFailed` bump it), so the sweeper can
cap re-attempts at `MAX_DELIVERY_ATTEMPTS`.

## 5. Idempotency: the dedupe collision is a no-op

A notification must not be sent twice for the same event. At-least-once delivery means the
**same event** can arrive more than once — a normal redelivery, or two consumers racing on
one event. The pipeline collapses both to a single delivery, in two layers:

1. **Explicit pre-check (the redelivery case).** Before opening a row, for a
   **customer-facing** notification (`recipientCustomerId !== null`) the use case calls
   `deliveryRepo.findByDedupeKey(template.id, eventReferenceType, eventReferenceId,
   channel, recipientCustomerId)` — five arguments, one per component of the generated
   column, the resolved template id leading (see the
   [delivery document](02-notification-delivery-as-audit-trail.md) §3 for why it is in the
   key at all). If a row already exists, it logs *"duplicate delivery, skipping dispatch"*
   and **returns that row with no second `NOTIFIER` call**. This is the common path: the
   first delivery already completed, and the event was simply redelivered. A prior
   `skipped-no-consent` row counts as existing — the skip is recorded under the same key,
   so a redelivery collapses onto it instead of re-asking the consent gate.

2. **Database UNIQUE (the concurrent-race case).** If two consumers pass the pre-check at
   the same instant, both open a `queued` row and both attempt to `save`. The
   `notification_delivery.delivery_dedupe_key` STORED generated column is non-null only for
   customer-facing rows and is covered by a UNIQUE index; the race-loser's INSERT collides
   on `ER_DUP_ENTRY`, and the repository **re-loads and returns the winner's row** rather
   than throwing. The use case then sees a saved row that is no longer `queued` (the winner
   already dispatched it) and skips its own dispatch.

**System/ops notifications are intentionally not deduped.** When `recipientCustomerId` is
null the dedupe column is null, and MySQL treats multiple nulls as distinct — so the
pre-check is skipped and the UNIQUE never fires. A low-stock alert to the ops mailbox is
allowed to repeat; only customer-facing double-dispatch is suppressed. In practice that
covers more than ops mail: several *customer-facing* consumers also pass `null`, because
their wire contracts carry the resolved `customerEmail` but no `customerId` — see doc 02 §3.

Deduping at the database rather than with an application-level "have we sent this?" check
is deliberate: the check-then-insert gap is exactly the window an at-least-once race
exploits. The database UNIQUE has no such gap.

### 5a. The consent gate (ADR-037)

Between the dedupe pre-check and the `queued` persist sits a second customer-facing gate,
added by [ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md): the recipient's
channel consent. It runs only for a customer-facing dispatch (an ops row has no consent to
consult), and only *after* the pre-check, so a redelivery never re-asks it.

`consentCache.get(recipientCustomerId)` resolves an `IConsentSnapshot` **cache-aside** —
`ris:notifications:consent:v1:<customerId>` over the global `CACHE_PORT`, kept fresh by the
`customer.consent.updated` / `customer.erased` consumer, with the TTL only a staleness
safety net. There is deliberately **no per-delivery RPC** back to the gateway; the read is
also fail-safe (a cache outage degrades to the raw-SQL reader, a reader failure to
`DEFAULT_CONSENT`), because this code runs inside an `@EventPattern` where a throw would
blind-redeliver the event.

The classification, in `isChannelConsented`:

| Dispatch | Gated on |
|---|---|
| `email` whose `eventType` ∈ `TRANSACTIONAL_EVENT_TYPES` (the nine retail keys) | `transactionalEmail` (default **true** — the bypass: an order confirmation still goes out with marketing off) |
| `email` whose `eventType` ∉ that set (e.g. `marketing.email.promo`) | `marketingEmail` (default **false**) |
| `sms` | `marketingSms` (default **false**) |
| `push` / `webhook` | ungated — out of scope for this capability, and a documented send rather than a silent drop |

If the applicable flag is false, the use case persists a **terminal
`skipped-no-consent`** row via `NotificationDelivery.skipped(...)` — recording the
subject/body that *would* have been sent, for the audit trail — and returns **without
calling the `NOTIFIER`**. The suppression is a first-class auditable outcome, not a
silence.

## 6. The null-subject transport fallback

The `Notification` value object requires a **non-empty subject** (an email without a
subject line is malformed). But `sms`/`push` templates carry a **null** subject by design.
So when the rendered subject is null (or renders to empty), the use case supplies a safe
fallback — **`input.eventType`** — as the transport subject:

```ts
const subjectForTransport =
  renderedSubject && renderedSubject.trim().length > 0 ? renderedSubject : input.eventType;
```

The **persisted** `renderedSubject` stays null for those channels (the audit row is honest
about what the template produced); the fallback is a transport-only detail so the
`Notification` invariant holds. `eventType` is always non-empty (the template registry
enforces it) and is a meaningful identifier for the message. This capability sends only
`email` (which always has a subject), so the fallback is exercised only once
non-email channels are seeded — but it is in place so they work without a code change.

## 7. Missing-template — and unrenderable-template — behavior

If `findLatestActive` returns null, there is **no template to render** — a seed/config
gap, not a delivery. The use case logs a `warn` (carrying `correlationId`, `eventType`,
`channel`, `locale`) and **returns `null` without persisting a delivery row**. A `queued`
row with no template behind it would be unrenderable noise that the retry sweeper could
never satisfy; the absence of a row is the correct state for "we had nothing to send." The
warn surfaces the gap in logs so the missing template can be authored.

**The same treatment now covers a template that resolves but cannot produce a message.**
Two further branches sit around the render call:

- **The render throws** — a malformed staff-authored Handlebars source. The `try/catch`
  warn-logs (with the `templateId` and the engine's message) and returns `null`.
- **The render yields an empty body.** `NotificationDelivery.open` rejects an empty
  `renderedBody` with a plain `Error`, so persisting one would throw anyway; the guard
  warn-logs and returns `null` first.

Both exist for the same reason the missing-template branch does, plus one more: this code
runs inside an `@EventPattern` consumer, where an escaping exception triggers a blind
redelivery under at-least-once RMQ — so a template bug would become a hot loop rather than
one log line.

## 8. What this use case returns, and what it does not do

It returns the resulting `NotificationDelivery` (sent / failed / the `skipped-no-consent`
row / the pre-existing duplicate), or `null` when no template resolved or the render
produced nothing. The return is there for testability and for a caller that wants the row;
**the event consumers ignore it**. A `NotificationDeliveryView` projection belongs to the
delivery-read operations, not here.

It adds **no RPC or HTTP surface of its own** — it is invoked in-process, so there is no
exception filter to map domain errors to HTTP here (the authoring RPCs introduce the first
such surface). It is the **only** notification delivery path: every consumer routes its
wire event through this pipeline, and the inline hard-coded `Send*` notification use cases
it replaced have been deleted.

That "invoked in-process by the event consumers" is now one caller short of the whole
story. Since [ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md) it has a
**second, non-consumer caller**: `SendMarketingUseCase`, behind the
`notification.marketing.send` RPC (fronted by `POST /api/notifications/marketing/send`).
That use case is a thin mapper — channel `email`, `eventReferenceType` the literal
`marketing`, `eventReferenceId` the per-send `campaignId` — and it is the one caller that
*does* use the return, projecting it to a `NotificationDeliveryView` for the operator. The
pipeline itself is unchanged by it: because a marketing `eventType` is absent from
`TRANSACTIONAL_EVENT_TYPES`, the consent gate (§5a) weighs it against `marketingEmail` with
no special-casing.

`correlationId` is logged **inline** in every branch — `PinoLogger.assign` throws outside
an HTTP request scope, and these flows run inside `@EventPattern` handlers
([ADR-011](../../adr/011-notifier-port-and-adapters.md) §7).
