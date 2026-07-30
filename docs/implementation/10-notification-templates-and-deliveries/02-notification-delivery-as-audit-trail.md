# The `NotificationDelivery` audit trail

This document introduces the **`NotificationDelivery`** aggregate — the queryable record
of one outgoing notification. It covers the model, its table, the status lifecycle, the
database-level double-dispatch guard, the repository port, the **audit query** (filters +
paging), and the **Record Delivery Outcome** seam that flips a `sent` delivery to
`delivered`/`bounced`. The operation that **writes** delivery rows (Render & Dispatch) and
the retry sweeper that re-attempts `failed` rows are described in sibling documents; this
document covers the row's full lifecycle and every way the trail is read.

## 1. The delivery row is the source of truth for "did we send this?"

Before this capability the notification service emitted into a log adapter and forgot.
There was no answer to "did we already email this customer about order 42?", no retry of
a transient failure, no bounce tracking. The `NotificationDelivery` row **is** that
answer: every outgoing notification leaves exactly one row, persisted **before** the
transport call, carrying the rendered content, the recipient, the triggering event, and
the outcome.

A delivery names:

- the `templateId` the subject/body were rendered from;
- the recipient — `recipientAddress` (the concrete email/phone/url) and a nullable
  `recipientCustomerId` (the gateway customer UUID, or **null** for system/ops
  notifications like a low-stock alert to the ops mailbox);
- the triggering business event — `eventReferenceType`
  (`order` / `return-request` / `stock-low` / `fulfillment` / `refund` / `marketing`) and
  `eventReferenceId`;
- the materialized `renderedSubject` (nullable) / `renderedBody`, the `correlationId`,
  and the outcome fields below.

## 2. The status lifecycle

`status` is `NotificationDeliveryStatusEnum`
(`queued` / `sent` / `delivered` / `failed` / `bounced`), a wire contract in
`libs/contracts/notifications`. Since
[ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md) the enum carries a
**sixth** member, `skipped-no-consent`, added by migration
`1783269124759-AddSkippedNoConsentDeliveryStatus`; it is described at the end of this
section. The aggregate enforces the transitions:

```
QUEUED  ──markSent──▶   SENT  ──markDelivered──▶ DELIVERED   (terminal)
QUEUED  ──markFailed─▶  FAILED                  ──markBounced─▶ BOUNCED (terminal)
FAILED  ──markSent──▶   SENT          (a retry succeeded)
FAILED  ──markFailed─▶  FAILED         (a retry failed again)
```

- `markSent(at)` / `markFailed(at, reason)` are the two **attempt-consuming**
  transitions — legal only from `queued` or `failed`. Each increments `attemptCount`,
  stamps `lastAttemptAt`, and (sent) clears or (failed) records `failureReason`.
- `markDelivered()` / `markBounced(reason)` record a **downstream receipt** off a `sent`
  delivery — they do **not** count as attempts.
- An illegal transition (e.g. `markDelivered` off `queued`, `markSent` off a terminal
  state) raises `NotificationDomainException` with
  `DELIVERY_INVALID_STATUS_TRANSITION` (409). Assert `err.code`, never the message.

**`attemptCount` is monotonic** — only `markSent` / `markFailed` increment it, so it
never decreases. That is what lets the retry sweeper cap re-attempts: a delivery is
retryable while `status = failed AND attempt_count < MAX_DELIVERY_ATTEMPTS`.

**`skipped-no-consent` is terminal and is set at row creation** — it is not reachable
from `queued` at all, so it does not appear in the walk above. The consent gate in the
Render & Dispatch pipeline (ADR-037) writes the row directly in this status through the
second factory, `NotificationDelivery.skipped(...)`, when the recipient has not consented
to the channel: the row records what *would* have been sent (for the audit trail) while
the `NOTIFIER` is never called, so `attemptCount` stays `0`. Neither attempt mutator can
touch it afterwards (`assertAttemptable` accepts only `queued`/`failed`) and neither
receipt mutator can (both require `sent`), so it is terminal by construction.

**Two of the five original statuses have no producer today.** `delivered` and `bounced`
are written *only* by `notification.delivery.record-outcome` (§8), the ESP-webhook seam —
and no webhook bridge exists anywhere in the system, no gateway route fronts that RPC, and
the default `LogNotifierAdapter` reports nothing back. A delivery filter on either
therefore returns an empty list **always**, not "not yet". The reachable terminal states
are `sent`, `failed` and `skipped-no-consent`.

## 3. The MySQL generated-column dedupe — what it does and doesn't cover

RabbitMQ is at-least-once ([ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)), so
two consumers can race the *same* event. Without a guard, both would persist a delivery
and the customer would get two emails. MySQL has **no partial unique index**, so —
following the [ADR-026](../../adr/026-price-append-only-ledger-and-tax-category.md)
`open_scope_key` precedent — `notification_delivery` carries a **STORED generated
column**:

```sql
delivery_dedupe_key VARCHAR(255) GENERATED ALWAYS AS (
  CASE WHEN recipient_customer_id IS NOT NULL
       THEN CONCAT(template_id, ':', event_reference_type, ':',
                   event_reference_id, ':', channel, ':',
                   recipient_customer_id)
       ELSE NULL END
) STORED
```

under a `UNIQUE` index. **`template_id` leads the key, and it has to.** Several *distinct*
event types share one business reference — the whole `retail.return.requested` /
`.authorized` / `.received` / `.inspected` family is keyed on the same `rmaId` and the same
recipient — so a key without the template id would collapse all four lifecycle emails into
one row and only the first would ever send. Each event type resolves its own template, so
the template id is what keeps them apart; a *true* redelivery of the same event resolves
the same active template and still collides, which is the collision we want.

The effect:

- **Customer-facing notifications are deduped.** At most one delivery per
  `(template_id, event_reference_type, event_reference_id, channel, recipient_customer_id)`.
  The race-loser's INSERT collides on `ER_DUP_ENTRY`; the repository catches it and re-loads
  the winner's row, so the dispatch is idempotent (the
  `ReservationTypeormRepository` ER_DUP_ENTRY-translation precedent).
- **System/ops notifications are NOT deduped.** When `recipient_customer_id IS NULL` the
  generated key is NULL, and MySQL treats multiple NULLs under a UNIQUE index as
  distinct — so each low-stock alert is a fresh row (you *want* every threshold breach
  logged).

The column is computed by MySQL; **no application code writes it**, and it is not mapped
on the entity (the ADR-026 stance — `synchronize` is off, so an INSERT that omits it lets
the DB compute it). What it does **not** cover: it is
per-template-per-event-per-channel-per-customer, so the same customer can still receive an
`order` email *and* an `order` SMS (different channel), and two *different* events about
the same order each get their own delivery (different template).

One further gap is worth stating plainly, because it is invisible from the schema: **most
consumers pass a null `recipientCustomerId`, so most deliveries are not deduped at all.**
Only the wire events that carry the buyer's id — `retail.order.placed` and the four
`retail.return.*` — reach `dispatchCustomerEmailNotification` with a non-null id. The
`retail.order.cancelled`, `retail.fulfillment.shipped` / `.delivered` and
`retail.refund.issued` contracts carry the resolved `customerEmail` but **no `customerId`**,
so their consumers pass `null` and an at-least-once redelivery may re-send them. That is a
known limitation of those contracts, not of the guard.

## 4. Never soft-deleted; hard-deleted once it ages out

A delivery row is **never soft-deleted** — the inherited `deletedAt` stays inert, and
deliberately so: the row is the source of truth for *"did we already send this?"*, so a
hidden-but-present row the dedupe query no longer sees would mean the same notification
goes out twice.

This capability shipped `RETENTION_DELIVERY_DAYS` (defaulted in the Joi schema) **ahead of
its consumer**, on the reasoning that the operational knob should exist before the sweeper
that reads it, and left the table growing monotonically in the meantime. That gap was not
short: the key sat in the shared schema with no DI token, no provider and no reader, so an
operator who set `RETENTION_DELIVERY_DAYS=7` got a clean boot and no purge, while the
busiest table in the schema — a row per notification on the hot path of every order,
fulfillment, return and refund — grew for the life of the deployment.

**It has since been closed** (ISSUE-08). `PurgeAgedDeliveriesUseCase`
(`application/use-cases/purge-aged-deliveries.use-case.ts`) computes the horizon as
`now − RETENTION_DELIVERY_DAYS` (Joi default **90**) and calls
`INotificationDeliveryRepositoryPort.deleteOlderThan(horizon, limit)`; the value provider
that finally reads the key lives in `notifications.module.ts`.
`DeliveryRetentionScheduler` (`infrastructure/scheduling/`) fires it nightly on
`@Cron(CronExpression.EVERY_DAY_AT_3AM)` — the service's **second** timer, alongside the
retry sweeper's `@Interval`.

Two properties of that sweep matter here:

- **It is a HARD `DELETE`, and it must be.** Soft-deleting is the tempting shortcut and it
  is the wrong verb for exactly the reason above — the row *is* the dedupe anchor. There is
  no third option.
- **The retention horizon and the dedupe guarantee are therefore coupled, deliberately.**
  Purging a row past the horizon retires its dedupe anchor with it, so an event re-processed
  after that point would dispatch a second notification. That is safe *because RabbitMQ will
  not redeliver a ninety-day-old message* — a real argument, and one that stops holding if
  the horizon is ever shortened to something a broker can outlive.

The `DELETE` is bounded by a batch ceiling (500 rows) so one sweep can never take a
table-sized lock; a backlog drains across successive nights rather than in one statement.

## 5. The table

`notification_delivery` (one migration, `synchronize` off):

| column | type | notes |
|---|---|---|
| `id` | BIGINT UNSIGNED PK | `BaseEntity` |
| `template_id` | BIGINT UNSIGNED | FK → `notification_template(id)` `ON DELETE RESTRICT` (deliveries outlive template-edit churn) |
| `recipient_customer_id` | VARCHAR(64) NULL | null for system/ops; also drives the dedupe column |
| `recipient_address` | VARCHAR(255) | email/phone/url |
| `channel` | ENUM(`email`,`sms`,`push`,`webhook`) | |
| `event_reference_type` | VARCHAR(32) | `order`/`return-request`/`stock-low`/`fulfillment`/`refund`/`marketing` |
| `event_reference_id` | VARCHAR(64) | |
| `status` | ENUM(`queued`,`sent`,`delivered`,`failed`,`bounced`,`skipped-no-consent`) DEFAULT `queued` | the sixth member was appended by the ADR-037 migration (§2) |
| `attempt_count` | INT DEFAULT 0 | monotonic |
| `last_attempt_at` | TIMESTAMP NULL | |
| `failure_reason` | TEXT NULL | |
| `rendered_subject` | TEXT NULL | |
| `rendered_body` | TEXT | |
| `correlation_id` | VARCHAR(64) | |
| `delivery_dedupe_key` | VARCHAR(255) STORED generated | the dedupe backstop (§3), `template_id`-led; **not mapped on the entity** |
| `created_at`/`updated_at` | timestamps | `BaseEntity`; `created_at` is the retention horizon column (§4) |
| `deleted_at` | TIMESTAMP NULL | **inert** — the row is hard-deleted or not at all (§4) |

Indexes: `UNIQUE (delivery_dedupe_key)` (the dedupe guard), `(status, last_attempt_at)`
(the retry sweeper scan), `(event_reference_type, event_reference_id)` (audit lookups),
`(recipient_customer_id, created_at)` (per-customer history).

## 6. The repository port

`INotificationDeliveryRepositoryPort` (`NOTIFICATION_DELIVERY_REPOSITORY`) returns domain
types only (the [ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)
boundary): `save` (with the ER_DUP_ENTRY → load-existing path of §3), `findById`,
`findByDedupeKey(templateId, eventReferenceType, eventReferenceId, channel,
recipientCustomerId)` (the explicit idempotency pre-check — five arguments, one per
component of the generated column), a paged filtered `list`,
`listRetryable(maxAttempts, limit, queuedStaleBefore)` (the sweeper scan — **two arms**:
`failed` rows under the attempt cap, and `queued` rows older than the staleness horizon, the
orphan-rescue arm described in the [retry document](06-retry-and-failure-events.md) §1a. A
**bounded batch, not a page**: the sweeper only iterates the rows, so it skips the `COUNT(*)`
the paged `list` pays), and
`deleteOlderThan(horizon, limit)` (the retention sweep of §4 — the port's only destructive
verb). `NotificationDeliveryTypeormRepository` is the single
`@InjectRepository(NotificationDeliveryEntity)` site. `NotificationDeliveryView` (in
`libs/contracts/notifications`) is the RPC/HTTP response shape.

## 7. Querying the trail — filters and paging

Two read RPCs expose the delivery trail to staff (the gateway HTTP routes that front them
**landed** — `GET /api/notifications/deliveries` and `.../deliveries/:id`, both under
`notifications:read`; see the [gateway API document](07-notifications-api-and-http-file.md)):

- **`notification.delivery.list`** → `ListDeliveriesUseCase` — the paginated, filterable
  audit query. The payload (`INotificationDeliveryListPayload`) carries four optional
  filters and a page request:
  - `customerId` → the row's `recipient_customer_id` (one customer's notification
    history, served by the `(recipient_customer_id, created_at)` index);
  - `eventReferenceType` + `eventReferenceId` → every delivery triggered by one business
    event (served by the `(event_reference_type, event_reference_id)` index);
  - `status` → one lifecycle state (e.g. every `bounced` delivery);
  - `page` (1-based) + `pageSize`.

  Every field is **optional and narrows** the scan — an absent field widens it, so an
  empty filter lists *every* delivery. Results come back **newest-first**
  (`created_at DESC, id DESC` — the `id` tiebreaker makes the order total when two rows
  share a timestamp) in the canonical `IPage<NotificationDeliveryView>` envelope
  (`{ items, total, page, size }`). The read is **uncached** — an audit query is
  low-frequency, operator-driven, and must show the latest rows; caching would add an
  invalidation hop on every dispatch for no hit-rate benefit (the inventory
  movements-ledger precedent). When the payload omits `page`/`pageSize`, the use case
  applies a `1` / `20` backstop (the gateway DTO also defaults them at the edge). That
  backstop is the shared `clampPageWindow` helper from `libs/common/pagination/`, and it
  does more than default: it **floors before the positivity check** (a fractional page in
  `(0, 1)` would otherwise pass a naive `> 0` test and floor to `0`, which a
  `skip((page − 1) * size)` repository turns into a *negative* offset) and it **caps `size`
  at 100**. The cap living in the use case rather than only in the gateway DTO is the point
  — an RPC handler has no `ValidationPipe` in front of it, so a direct RMQ caller could
  otherwise ask the database for an unbounded result set.

- **`notification.delivery.get`** → `GetDeliveryUseCase` — the single-row drill-down by
  id, returning the full `NotificationDeliveryView` (including the materialized
  `renderedBody`/`renderedSubject`). An unknown id raises `NotificationDomainException`
  with `DELIVERY_NOT_FOUND` (404).

## 8. Record Delivery Outcome — the ESP-webhook seam

A `sent` status means the **transport accepted** the message — not that it reached the
inbox. The final word comes asynchronously from the provider: a *delivery receipt* or a
*bounce notice*. **`notification.delivery.record-outcome`** → `RecordDeliveryOutcomeUseCase`
is the seam that records it:

```
SENT  ──outcome 'delivered'──▶  DELIVERED   (a delivery receipt)
SENT  ──outcome 'bounced'────▶  BOUNCED     (a bounce notice; failureReason recorded)
```

The use case loads the delivery (`DELIVERY_NOT_FOUND` on a miss), then calls the domain
mutator the outcome selects — `markDelivered()` or `markBounced(reason)`. Those mutators
are the **single source** of the `sent`-only guard: a non-`sent` source row (`queued`,
`failed`, or already-`delivered`/`bounced`) raises `DELIVERY_INVALID_STATUS_TRANSITION`
(409). Both transitions are **attempt-free** — they record a downstream receipt, not a new
send, so `attemptCount` does not move (only `markSent`/`markFailed` consume an attempt,
§2). A `bounced` outcome with no `failureReason` falls back to a non-empty default so the
audit row always records *why* it bounced.

**The webhook ingestion itself is a documented stub.** A real ESP integration needs an
HTTP endpoint that verifies the provider's webhook signature and maps the provider's
payload shape onto `{ deliveryId, outcome, failureReason? }`. That bridge is **out of
scope** this capability — `RecordDeliveryOutcomeUseCase` is reachable only via the
`notification.delivery.record-outcome` RPC as the internal sketch the bridge would call,
and it is deliberately **not exposed at the gateway** (unlike the `list`/`get` reads, which
did get gateway routes — see doc 07 §3, which records the same decision from the gateway
side). Real ESP integration is still future work, and **no bridge exists anywhere in the
system**: nothing outside the notification service can reach this RPC, which is why
`delivered` and `bounced` have no producer at all (§2).

See the [sibling template document](01-notification-template-versioning.md) for the
versioned registry, and
[ADR-033](../../adr/033-notification-templates-deliveries-and-render-dispatch.md) for the
whole capability's rationale.
