# ADR-033: Notification templates, deliveries, and the render-and-dispatch pipeline

- **Date**: 2026-06-21
- **Status**: Accepted

---

## Context

The notification microservice ([ADR-011](011-notifier-port-and-adapters.md)) has, until
now, been **stateless and hard-coded**. Five inline use cases
(`SendLowStockAlert` / `SendOrderNotification` / `SendShipmentNotification` /
`SendReturnNotification` / `SendRefundNotification`) each consume a wire event, build a
`Notification` value object with a **subject and body assembled from string literals in
TypeScript**, and hand it to the `NOTIFIER` port (a `LogNotifierAdapter` by default).

That shape has three gaps:

- **No template authoring.** Changing the wording of the order-confirmation email means
  editing and redeploying code. There is no per-locale variation, no way for staff to
  own the copy, and no audit of who changed what.
- **No record that a notification was sent.** The service emits into the log adapter and
  forgets. There is no answer to "did we already email this customer about order 42?",
  no retry of a transient failure, no bounce tracking.
- **No idempotency.** RabbitMQ is at-least-once ([ADR-020](020-rabbitmq-as-inter-service-bus.md)).
  A redelivered event re-sends the notification, because nothing remembers the first
  send.

The notification microservice is also the **only durable-state-free service** — it has
no `DatabaseModule` wiring and no persistence layer at all.

No production data exists, so this is a clean addition.

This ADR records the **whole notification-templates-and-deliveries capability** in one
decision (the [ADR-029](029-category-materialized-path-and-polymorphic-media.md) /
[ADR-030](030-reservation-ttl-aggregate-and-stock-movement-ledger.md) /
[ADR-031](031-fulfillment-aggregate-and-ship-triggered-capture.md) /
[ADR-032](032-returns-and-refunds-rma-lifecycle-and-restock.md) precedent — one ADR
decides the capability, the code lands across several sessions). The foundation (the two
aggregates + their tables + repositories + the wire enums/views + the error codes +
the DB wiring) ships first; the Handlebars renderer, the Render & Dispatch use case, the
Author / Activate / List operations, the delivery reads, the retry sweeper, the producer
event enrichment, the consumer rewiring, and the gateway endpoints follow.

## Decision

### The notification microservice gains persistence

It joins the shared `retail_db` via `DatabaseModule.forRoot(notificationEntities)` at its
`app.module.ts` (the inventory `app.module.ts` shape), and owns its first two tables.
`synchronize` stays off ([ADR-019](019-typeorm-and-mysql-for-persistence.md)) — the
schema is owned by one migration. No new database is provisioned; sharing the one MySQL
instance keeps the local stack a single connection per service, consistent with every
other context.

### `NotificationTemplate` — a versioned registry

`NotificationTemplate extends AggregateRoot<number | null>` is one entry in a registry
keyed on the natural triple **`(eventType, channel, locale)`** — *which* business event,
over *which* channel (`email`/`sms`/`push`/`webhook`, the wire
`NotificationChannelEnum`), in *which* locale.

- **An edit appends a new `version`.** The unique key is
  `(event_type, channel, locale, version)`, so every version is a distinct retained row.
  Editing the order-confirmation email does not overwrite the live row — it writes a new
  one at `version + 1`, leaving the full edit history for audit and rollback. The live
  entry for a key is the **highest-`version` `active` row**.
- **`version` is the BUSINESS version, not an OCC token.** It is a plain `INT` the
  registry owns and that participates in the natural key. This is deliberately distinct
  from `order.version` / `fulfillment.version` (TypeORM-managed `@VersionColumn`
  optimistic-lock tokens). The notification tables ship **no** OCC column —
  last-writer-wins is acceptable for a staff-authored registry (the catalog stance,
  [ADR-025](025-catalog-product-and-variant-aggregate.md)).
- **Soft-delete is via `active`, never `deletedAt`.** Deactivating a template flips it
  out of the "find latest active" resolution while keeping the row (the `StockLocation` /
  `Category` convention). `deletedAt` stays inert.
- **The subject rule is channel-specific.** `subject` is required for `email`/`webhook`
  and optional (nullable) for `sms`/`push` — an SMS has no subject line. The aggregate
  enforces it; the column is `TEXT NULL`.
- It records **no domain events** (the `Category` / `MediaAsset` precedent,
  [ADR-029](029-category-materialized-path-and-polymorphic-media.md)) — a template edit
  is an internal registry change.

The `(event_type, channel, locale, active)` index backs the "find latest active"
hot-path query the render pipeline runs on every outgoing notification.

### `NotificationDelivery` — the audit trail

`NotificationDelivery extends AggregateRoot<number | null>` is the queryable record of
one outgoing notification — the source of truth for "did we send this, and how did it
go?". Its `status` walks
`queued → sent → delivered | bounced`, with `queued|failed → failed` (and
`failed → sent` once a retry succeeds). It carries `attemptCount`, `lastAttemptAt`,
`failureReason`, the materialized `renderedSubject` / `renderedBody`, the
`recipientAddress` (and a nullable `recipientCustomerId` — null for system/ops
notifications), the triggering `(eventReferenceType, eventReferenceId)`, and the
`correlationId`.

- **`attemptCount` is monotonic.** Only the two attempt-consuming transitions
  (`markSent` / `markFailed`) increment it; `markDelivered` / `markBounced` record a
  downstream receipt and leave it. It therefore never decreases, which lets the retry
  sweeper cap re-attempts at `MAX_DELIVERY_ATTEMPTS`.
- **The row is live-ephemeral.** It is never deleted; a `RETENTION_DELIVERY_DAYS`-driven
  purge is a deferred future capability, so `deletedAt` stays inert. The env var ships
  (defaulted in the Joi schema) ahead of its consumer.

Three indexes back the read paths: `(status, last_attempt_at)` for the retry sweeper,
`(event_reference_type, event_reference_id)` for audit lookups, and
`(recipient_customer_id, created_at)` for per-customer history.

### The Render & Dispatch pipeline

The render-and-dispatch flow (a later session) is **persist-then-send**:

1. Resolve the latest-active template for the event's `(eventType, channel, locale)`.
2. Render `subject` / `body` from the template source against the event payload.
3. **Persist a `NotificationDelivery` row in `queued` BEFORE the `NOTIFIER` call.** A
   crash mid-send then still leaves an auditable row the retry sweeper can pick up.
4. Call the `NOTIFIER` (the existing port, unchanged) with a `Notification` carrying the
   rendered content.
5. On success flip the delivery `→ sent`; on failure flip it `→ failed` with the reason.

The **`NOTIFIER` port is preserved** (one method) — the rendered subject/body thread
through the existing `Notification` value object; the template/delivery machinery sits
*in front of* the transport, not inside it. The default transport stays
`LogNotifierAdapter`.

### Handlebars as the renderer

Template bodies are **Handlebars** source. Handlebars is logic-less by design (no
arbitrary code in a template), which is the right safety posture for content that may be
staff-authored. The renderer (a later session) compiles the template against a bounded
context object; **untrusted template *content* is never compiled from an end-user**, only
from staff with `notifications:write`. HTML-escaping for the email channel is the
renderer's responsibility.

### Producer events carry `customerEmail` / `customerLocale`

To render and address a customer-facing notification, the dispatch path needs the
recipient's email and preferred locale. Rather than a **per-delivery cross-service RPC**
back to the gateway's `customer` aggregate (synchronous coupling on every notification,
option (a)), the **producer events carry `customerEmail` / `customerLocale`** on the wire
(option (b), a later session). The retail/inventory producers already own the
order/customer context at emit time; enriching the event is cheaper and removes a
runtime dependency from the notification hot path.

### Retry and the failure event

A retry sweeper (a later session) scans `listRetryable(MAX_DELIVERY_ATTEMPTS)` —
`failed` deliveries under the attempt cap, oldest-first — and re-attempts them. A
delivery that exhausts `MAX_DELIVERY_ATTEMPTS` emits a `notifications.delivery.failed`
event (the dead-letter surface for an operator/alert).

### Double-dispatch idempotency via a generated-column UNIQUE

Two consumers racing the same at-least-once event must not produce two deliveries to the
same customer. MySQL has **no partial unique index**, so — following the
[ADR-026](026-price-append-only-ledger-and-tax-category.md) `open_scope_key` precedent —
`notification_delivery` carries a **STORED generated column** `delivery_dedupe_key` that
is non-NULL only when `recipient_customer_id IS NOT NULL`, computed as
`CONCAT(event_reference_type, ':', event_reference_id, ':', channel, ':', recipient_customer_id)`,
under a UNIQUE index. Effect:

- at most one **customer-facing** delivery per
  `(event_reference_type, event_reference_id, channel, recipient_customer_id)` — the
  race-loser's INSERT collides on `ER_DUP_ENTRY`, and the repository re-loads and returns
  the winner's row (idempotent, the `ReservationTypeormRepository`
  ER_DUP_ENTRY-translation precedent);
- **system/ops** notifications (`recipient_customer_id IS NULL`) are NOT deduped — MySQL
  treats multiple NULLs as distinct, so each low-stock alert is a fresh row.

The column is computed by MySQL; no application code writes it, and it is **not mapped on
the entity** (the ADR-026 stance — `synchronize` is off, an INSERT that omits it lets the
DB compute it).

## Alternatives Considered

- **Keep notifications stateless; never persist.** Rejected — it leaves the three gaps
  (no authoring, no audit, no idempotency) unaddressed. At-least-once delivery makes "did
  we already send this?" a correctness question, not a nicety.
- **A separate notification database.** Rejected — every other context shares the one
  `retail_db`; a second database buys cross-database joins and a second connection for no
  isolation benefit at this scale. The notification tables FK only their own
  `notification_template`.
- **A per-delivery RPC to fetch the recipient's email/locale.** Rejected in favor of
  enriching the producer event (above) — it adds synchronous cross-service coupling to
  the notification hot path.
- **An application-level "have we sent this?" check instead of the generated column.**
  Rejected — a check-then-insert race window is exactly what at-least-once delivery
  exploits; the database UNIQUE is the only airtight guard. The partial-index emulation
  is the ADR-026 precedent.
- **An OCC `@VersionColumn` on the template.** Rejected — the registry's `version` is a
  business concept (which edit), and last-writer-wins is acceptable for staff-authored
  copy; an OCC token would conflate the two meanings.
- **A richer templating engine (EJS / raw JS).** Rejected — logic-ful templates are a
  code-injection surface for staff-authored content; Handlebars's logic-less design is
  the safer default.

## Consequences

- The notification microservice now has durable state — its first DB tables — and a
  persistence layer (entities, mappers, two repository ports, `DatabaseModule` wiring).
- Notification copy becomes **data, not code**: staff author/version/activate templates
  per `(eventType, channel, locale)` without a redeploy, with full edit history.
- Every outgoing notification leaves an **auditable, queryable delivery row**;
  transient failures are retryable, bounces are tracked, and double-dispatch is
  idempotent at the database.
- The five inline, hard-coded use cases are superseded by the render-and-dispatch
  pipeline (their removal lands in a later session, once the pipeline exists).
- Two RBAC codes (`notifications:read` / `notifications:write`) and three env vars
  (`OPS_NOTIFICATIONS_EMAIL`, `MAX_DELIVERY_ATTEMPTS`, `RETENTION_DELIVERY_DAYS`) ship
  ahead of their first consumers (a prior reconciliation slice).
- A `notificationsTemplate(...)` cache-key builder (`v1`) is added unconsumed — the
  registry resolution is the natural future caching candidate, and the builder lets a
  future cached read path adopt the key shape without re-keying.
- The foundation persists nothing yet (no use case resolves the two repositories); the
  ports are wired so the later sessions only add behavior, never plumbing.

## References

- [ADR-011](011-notifier-port-and-adapters.md) — the `NOTIFIER` port and the notification
  microservice as the per-module template (preserved here).
- [ADR-019](019-typeorm-and-mysql-for-persistence.md) — TypeORM + MySQL, migration
  workflow, `synchronize` off.
- [ADR-026](026-price-append-only-ledger-and-tax-category.md) — the `open_scope_key`
  STORED generated-column UNIQUE that emulates a partial unique index (the dedupe
  precedent).
- [ADR-016](016-cache-aside-generalized.md) / [ADR-022](022-cache-keys-tenant-and-schema-version.md)
  — the cache-key builder convention (the unconsumed `notificationsTemplate` builder).
- [ADR-029](029-category-materialized-path-and-polymorphic-media.md) /
  [ADR-030](030-reservation-ttl-aggregate-and-stock-movement-ledger.md) /
  [ADR-031](031-fulfillment-aggregate-and-ship-triggered-capture.md) /
  [ADR-032](032-returns-and-refunds-rma-lifecycle-and-restock.md) — the one-ADR-decides,
  code-lands-across-sessions precedent.
