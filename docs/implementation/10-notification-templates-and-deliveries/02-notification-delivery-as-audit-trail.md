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
  (`order` / `return-request` / `stock-low` / `fulfillment` / `refund`) and
  `eventReferenceId`;
- the materialized `renderedSubject` (nullable) / `renderedBody`, the `correlationId`,
  and the outcome fields below.

## 2. The status lifecycle

`status` is `NotificationDeliveryStatusEnum`
(`queued` / `sent` / `delivered` / `failed` / `bounced`), a wire contract in
`libs/contracts/notifications`. The aggregate enforces the transitions:

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
       THEN CONCAT(event_reference_type, ':', event_reference_id, ':',
                   channel, ':', recipient_customer_id)
       ELSE NULL END
) STORED
```

under a `UNIQUE` index. The effect:

- **Customer-facing notifications are deduped.** At most one delivery per
  `(event_reference_type, event_reference_id, channel, recipient_customer_id)`. The
  race-loser's INSERT collides on `ER_DUP_ENTRY`; the repository catches it and re-loads
  the winner's row, so the dispatch is idempotent (the
  `ReservationTypeormRepository` ER_DUP_ENTRY-translation precedent).
- **System/ops notifications are NOT deduped.** When `recipient_customer_id IS NULL` the
  generated key is NULL, and MySQL treats multiple NULLs under a UNIQUE index as
  distinct — so each low-stock alert is a fresh row (you *want* every threshold breach
  logged).

The column is computed by MySQL; **no application code writes it**, and it is not mapped
on the entity (the ADR-026 stance — `synchronize` is off, so an INSERT that omits it lets
the DB compute it). What it does **not** cover: it is per-event-per-channel-per-customer,
so the same customer can still receive an `order` email *and* an `order` SMS (different
channel), and two *different* events about the same order each get their own delivery.

## 4. Live-ephemeral, with retention deferred

A delivery row is **live-ephemeral**: it is never deleted, so the inherited
`deletedAt` stays inert. A `RETENTION_DELIVERY_DAYS`-driven purge of old rows is a
**deferred future capability** — the env var ships now (defaulted in the Joi schema)
ahead of its consumer, so the operational knob exists before the sweeper that reads it.
Until that lands, the table grows monotonically (acceptable at this scale; no production
data exists).

## 5. The table

`notification_delivery` (one migration, `synchronize` off):

| column | type | notes |
|---|---|---|
| `id` | BIGINT UNSIGNED PK | `BaseEntity` |
| `template_id` | BIGINT UNSIGNED | FK → `notification_template(id)` `ON DELETE RESTRICT` (deliveries outlive template-edit churn) |
| `recipient_customer_id` | VARCHAR(64) NULL | null for system/ops; also drives the dedupe column |
| `recipient_address` | VARCHAR(255) | email/phone/url |
| `channel` | ENUM(`email`,`sms`,`push`,`webhook`) | |
| `event_reference_type` | VARCHAR(32) | `order`/`return-request`/`stock-low`/`fulfillment`/`refund` |
| `event_reference_id` | VARCHAR(64) | |
| `status` | ENUM(`queued`,`sent`,`delivered`,`failed`,`bounced`) DEFAULT `queued` | |
| `attempt_count` | INT DEFAULT 0 | monotonic |
| `last_attempt_at` | TIMESTAMP NULL | |
| `failure_reason` | TEXT NULL | |
| `rendered_subject` | TEXT NULL | |
| `rendered_body` | TEXT | |
| `correlation_id` | VARCHAR(64) | |
| `delivery_dedupe_key` | VARCHAR(255) STORED generated | the dedupe backstop (§3); **not mapped on the entity** |
| `created_at`/`updated_at` | timestamps | `BaseEntity` |
| `deleted_at` | TIMESTAMP NULL | **inert** |

Indexes: `UNIQUE (delivery_dedupe_key)` (the dedupe guard), `(status, last_attempt_at)`
(the retry sweeper scan), `(event_reference_type, event_reference_id)` (audit lookups),
`(recipient_customer_id, created_at)` (per-customer history).

## 6. The repository port

`INotificationDeliveryRepositoryPort` (`NOTIFICATION_DELIVERY_REPOSITORY`) returns domain
types only (the [ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)
boundary): `save` (with the ER_DUP_ENTRY → load-existing path of §3), `findById`,
`findByDedupeKey` (the explicit idempotency pre-check), a paged filtered `list`, and
`listRetryable(maxAttempts, page)` (the sweeper scan).
`NotificationDeliveryTypeormRepository` is the single
`@InjectRepository(NotificationDeliveryEntity)` site. `NotificationDeliveryView` (in
`libs/contracts/notifications`) is the RPC/HTTP response shape.

## 7. Querying the trail — filters and paging

Two read RPCs expose the delivery trail to staff (the gateway HTTP routes that front them
are a later capability):

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
  applies a `1` / `20` backstop (the gateway DTO also defaults them at the edge).

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
and it is deliberately **not exposed at the gateway** (unlike the `list`/`get` reads,
which do get gateway routes in a later capability). Real ESP integration is future work.

See the [sibling template document](01-notification-template-versioning.md) for the
versioned registry, and
[ADR-033](../../adr/033-notification-templates-deliveries-and-render-dispatch.md) for the
whole capability's rationale.
