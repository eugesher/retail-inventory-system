# The render-and-dispatch pipeline

This document introduces **`RenderAndDispatchUseCase`** — the single pipeline that turns a
business event into an outgoing notification. It loads the live template, renders the
subject/body, persists a `NotificationDelivery` row in `queued` **before** any transport
call, dispatches through the `NOTIFIER` port, then flips the row to `sent` or `failed`.
Every event consumer ultimately calls this one use case; the consumers themselves (the
translation from a specific wire event to the pipeline's input) are described in a sibling
document and are wired onto it in a later capability.

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
  eventReferenceType: string;         // 'order' | 'return-request' | 'stock-low' | 'fulfillment' | 'refund'
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
dedupe pre-check (customer-facing only) → existing row? → return it, no dispatch  (§5)
delivery = NotificationDelivery.open({ status: queued, … }) → deliveryRepo.save(delivery)   ◀── PERSIST
notifier.send(new Notification({ recipient, channel, subject, body, metadata }))            ◀── DISPATCH
  ├─ ok    → delivery.markSent(now)
  └─ throw → delivery.markFailed(now, reason)   (NOT rethrown — §4)
deliveryRepo.save(delivery)
return delivery
```

The order of the two marked steps — **persist, then dispatch** — is the whole point.

## 3. Why persist-before-dispatch

The `queued` row is written to the database **before** the `NOTIFIER` is called. If the
process crashes between the two — after the row commits but before (or during) the send —
the row survives in `queued`, and the retry sweeper (a later capability) re-attempts it.

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
   `deliveryRepo.findByDedupeKey(eventReferenceType, eventReferenceId, channel,
   recipientCustomerId)`. If a row already exists, it logs *"duplicate delivery, skipping
   dispatch"* and **returns that row with no second `NOTIFIER` call**. This is the common
   path: the first delivery already completed, and the event was simply redelivered.

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
allowed to repeat; only customer-facing double-dispatch is suppressed.

Deduping at the database rather than with an application-level "have we sent this?" check
is deliberate: the check-then-insert gap is exactly the window an at-least-once race
exploits. The database UNIQUE has no such gap.

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

## 7. Missing-template behavior

If `findLatestActive` returns null, there is **no template to render** — a seed/config
gap, not a delivery. The use case logs a `warn` (carrying `correlationId`, `eventType`,
`channel`, `locale`) and **returns `null` without persisting a delivery row**. A `queued`
row with no template behind it would be unrenderable noise that the retry sweeper could
never satisfy; the absence of a row is the correct state for "we had nothing to send." The
warn surfaces the gap in logs so the missing template can be authored.

## 8. What this use case returns, and what it does not do

It returns the resulting `NotificationDelivery` (sent / failed / the pre-existing
duplicate), or `null` when no template resolved. The return is there for testability and a
possible future caller; **the consumers ignore it**. A `NotificationDeliveryView`
projection belongs to the delivery-read operations (a sibling capability), not here.

It does **not** add any RPC or HTTP surface — it is invoked in-process by the event
consumers, so there is no exception filter to map domain errors to HTTP here (the
authoring RPCs introduce the first such surface). And it does not yet replace the inline
hard-coded notification use cases — those still run unchanged until the consumers are
rewired onto this pipeline.

`correlationId` is logged **inline** in every branch — `PinoLogger.assign` throws outside
an HTTP request scope, and these flows run inside `@EventPattern` handlers
([ADR-011](../../adr/011-notifier-port-and-adapters.md) §7).
