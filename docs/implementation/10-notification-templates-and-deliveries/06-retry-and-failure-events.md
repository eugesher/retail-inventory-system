# Retrying failed deliveries + the `notifications.delivery.failed` event

A notification dispatch can fail — the transport rejects the message, the provider is
briefly unavailable, a connection drops. The
[render-and-dispatch pipeline](03-render-and-dispatch-pipeline.md) records such a failure on
the [`NotificationDelivery` audit row](02-notification-delivery-as-audit-trail.md) (status
`failed`, a `failureReason`, an incremented `attemptCount`) rather than rethrowing. This
document covers what happens **next**: how those `failed` rows are re-attempted, by whom,
and what happens when a delivery exhausts its retry budget.

Two re-dispatch paths share one mechanism:

- **Manual** — `RetryDeliveryUseCase`, the `notification.delivery.retry` RPC an operator
  triggers to force one delivery to retry **now**.
- **Scheduled** — `RetryFailedDeliveriesUseCase`, a sweeper driven by `@nestjs/schedule`
  that periodically re-attempts `failed` rows on an exponential backoff.

Both honor a hard cap, `MAX_DELIVERY_ATTEMPTS`. When a delivery reaches it and is still
`failed`, the service emits `notifications.delivery.failed` — a reserved alerting surface.

This honors [ADR-033](../../adr/033-notification-templates-deliveries-and-render-dispatch.md)
(the retry + failure-event design),
[ADR-008](../../adr/008-rabbitmq-via-libs-messaging.md) (the new dotted producer key,
mirrored value-for-value into `MicroserviceMessagePatternEnum`), and
[ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md) (the event is published only
inside the `infrastructure/messaging/*-rabbitmq.publisher.ts` adapter, best-effort
post-state).

## 1. Manual vs. scheduled retry

The two paths differ only in **who decides a delivery is due** and **how a row is
selected**. The actual re-dispatch — rebuild the `Notification`, send it, flip the row,
emit at the cap — is one shared step (`RetryDeliveryUseCase.reattempt`), so there is a
single source of truth for "retry one delivery."

| | Manual (`RetryDeliveryUseCase`) | Scheduled (`RetryFailedDeliveriesUseCase`) |
|---|---|---|
| Trigger | `notification.delivery.retry` RPC (operator) | `@nestjs/schedule` `@Interval`, every 60s |
| Row selection | one delivery, by id | `listRetryable` scan (`failed` + `attempt_count < cap`, oldest-attempt-first) |
| Backoff gate | **ignored** — an operator forces it | **honored** — skips rows still inside their backoff window |
| Not-retryable | `DELIVERY_NOT_FOUND` (404) / non-`failed` → `DELIVERY_INVALID_STATUS_TRANSITION` (409) | row simply not in the scan |
| Returns | the `NotificationDeliveryView` | a `{ scanned, skipped, retried }` summary |

The manual path is the precise tool: an operator who has fixed the underlying cause (a bad
template, an expired credential) retries the affected delivery immediately instead of
waiting for the backoff to elapse. It is gated only on **status** — only a `failed`
delivery is retryable; a `queued` row is still awaiting its first dispatch and a
`sent`/`delivered`/`bounced` row already succeeded, so re-dispatching either would
double-send.

The scheduled path is the steady-state safety net: it drains the `failed` backlog without
anyone watching. `listRetryable` orders oldest-attempt-first and the sweep processes a
bounded batch, so a backlog larger than one page drains across successive sweeps (the
longest-waiting delivery always retries first).

The scheduler itself (`DeliveryRetryScheduler`, under `infrastructure/scheduling/`) is a
thin `@Interval`-annotated provider that `ScheduleModule.forRoot()` discovers; all retry
logic lives in the use case. A thrown sweep is caught and logged so a transient fault never
kills the scheduler loop.

## 2. Backoff policy + the `MAX_DELIVERY_ATTEMPTS` cap

**Backoff (scheduled only).** A `failed` row is *due* for a scheduled retry once its last
attempt is at least `backoff(attemptCount)` in the past:

```
backoff(attemptCount) = baseMs * 2 ^ (attemptCount - 1)      // baseMs = 1000
skip the row while  lastAttemptAt + backoff(attemptCount) > now
```

So after the 1st failure (`attemptCount === 1`) a row waits ~1s, after the 2nd ~2s, after
the 3rd ~4s, and so on — each failure roughly doubles the wait, spacing out re-attempts on
a flapping transport instead of hammering it. `baseMs` is deliberately small (1s) so the
loop — and the end-to-end test that exercises it — stays fast; a production deployment
would raise it (a `ConfigService` knob for the base is a natural future extension). The
**manual** retry ignores this gate entirely: an operator forcing a retry has already
decided it is due.

**The cap.** `MAX_DELIVERY_ATTEMPTS` (env, Joi default **3**) bounds how many times a
delivery is attempted in total. It is injected as a plain number through a `ConfigService`
value-provider token (`MAX_DELIVERY_ATTEMPTS`, the retail `RETURN_WINDOW_DAYS` /
inventory `RESERVATION_TTL_MINUTES` precedent), so the use cases never read env directly.

Because `attemptCount` is **monotonic** — only `markSent` / `markFailed` bump it, and they
never decrease it — the cap is a simple comparison. The scheduled scan filters
`attempt_count < MAX_DELIVERY_ATTEMPTS`, so once a re-attempt pushes the count to the cap,
the row **drops out of every subsequent scan**. That is what makes the failure event fire
*once* per exhausted delivery with no job table or "alerted" flag: the row that triggered
the alert is, by construction, never swept again.

(The first dispatch in the render-and-dispatch pipeline counts as attempt 1, so with the
default cap of 3 a delivery gets its original send plus two retries.)

## 3. The `notifications.delivery.failed` event — the downstream-alerting seam

When a (manual or scheduled) re-attempt leaves a delivery `failed` **and** at the cap, the
retry use case emits one `notifications.delivery.failed` event:

```ts
interface INotificationDeliveryFailedEvent extends ICorrelationPayload {
  deliveryId: number;
  eventReferenceType: string; // 'order' | 'return-request' | 'stock-low' | 'fulfillment' | 'refund'
  eventReferenceId: string;
  failureReason: string;      // the last NOTIFIER rejection
  eventVersion: 'v1';
  occurredAt: string;         // ISO-8601
}
```

It is published through `NOTIFICATION_EVENTS_PUBLISHER` → `NotificationRabbitmqPublisher`
(the notification service's sole outbound `ClientProxy` holder) onto the service's **own**
`notification_events` queue. **No consumer binds it today** — it is a *reserved surface*,
exactly like the `inventory.stock.*` reserved events elsewhere in the system. It exists so
that a future capability — an ops-alerting bridge (page on-call, open a ticket), a metrics
counter, or a dead-letter handler — can subscribe without the producer changing.

The payload is a thin header: `deliveryId` resolves the full audit row (subject, body,
recipient, the whole attempt history) via the delivery-read RPCs, and
`eventReferenceType` / `eventReferenceId` link the failure back to the originating business
event so an alert can be triaged without a second read. `failureReason` carries the last
transport rejection inline for at-a-glance triage.

The emit is **best-effort** (ADR-020): the delivery is already durably persisted `failed`,
so a publish failure is warn-logged and swallowed — losing the *alert* must never undo the
*record*. And the wire payload is a framework-free interface (ADR-011) — a domain object is
never serialized across the boundary; the use case maps the failed delivery onto it.

### Why the plural `notifications.*` prefix

The RPC commands are `notification.delivery.{list,get,record-outcome,retry}` (singular).
The failure event is `notifications.delivery.failed` (plural). The plural marks it as the
cross-cutting **alerting stream** — a fan-out surface for *any* downstream that cares about
delivery health — distinct from the singular request/response RPCs that act on one
delivery. Both forms are added to `ROUTING_KEYS` and mirrored value-for-value into
`MicroserviceMessagePatternEnum` (ADR-008), with the agreement asserted by the
routing-keys spec.

## 4. Why re-dispatch the already-rendered body (no template re-lookup)

A retry sends the `renderedSubject` / `renderedBody` **already persisted on the delivery
row** — it does **not** re-resolve the template or re-render. This is deliberate:

- **The row is a self-contained snapshot.** It captured exactly what was rendered at
  dispatch time. A retry that re-looked-up the template could send *different* content than
  the original attempt if the template was edited in between — the audit row would then no
  longer describe what was actually sent. Re-sending the stored body keeps the row honest:
  what you retry is what the row says.
- **It is simpler and cheaper.** No `findLatestActive`, no Handlebars compile, no render
  context to reconstruct (the original event's fields are long gone by retry time — the
  rendered output is all that survives). The retry needs only the row.
- **Template fixes flow through authoring, not retries.** If a template was broken, the
  operator authors a corrected version and the *next* event renders against it. A retry is
  for transient transport failures, not content bugs — so re-rendering would be solving the
  wrong problem.

The rebuilt `Notification` reuses the same null-subject transport fallback the pipeline
uses (a null `renderedSubject` — an sms/push row — falls back to `eventReferenceType` so
the value object's non-empty-subject invariant holds); email always carries a subject, so
the fallback is dormant for now.

## 5. What is deferred

- **A durable dead-letter queue.** A cap-exhausted delivery stays in the database as a
  `failed` row and emits `notifications.delivery.failed`; there is no separate
  poison-message queue or automatic escalation. The event **is** the seam a real
  dead-letter / ops-alert capability would consume — building that consumer (and deciding
  retention/escalation policy) is future work.
- **A real consumer for the event.** None binds it today; it is reserved.
- **A configurable backoff base + sweep interval.** Both are module constants (1s base,
  60s sweep) chosen to keep the system responsive and the tests fast; promoting them to
  env knobs is a small future change.
- **`RETENTION_DELIVERY_DAYS` purge.** Delivery rows (including exhausted-and-failed ones)
  are never deleted yet; the live-ephemeral retention policy is described in the
  [delivery audit-trail doc](02-notification-delivery-as-audit-trail.md) and remains
  deferred.
- **The gateway manual-retry HTTP route.** `notification.delivery.retry` is reachable over
  RMQ today; fronting it at the API gateway (the `notifications:write`-gated operator
  endpoint that calls this RPC) is a later capability.
