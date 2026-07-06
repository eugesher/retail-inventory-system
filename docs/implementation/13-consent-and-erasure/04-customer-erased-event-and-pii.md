# The customer privacy events and the no-PII erase contract

The consent-and-erasure capability produces two cross-service events that
announce a change to a customer's privacy state: `customer.consent.updated` when
a customer changes which channels they will accept messages on, and
`customer.erased` when a customer's personal data is destroyed. This document
describes both wire contracts, the two destinations they are published to and why,
and the deliberate rule that the erase event carries **no personal data at all**.
It also introduces the customer self-service consent endpoints that produce the
first of the two events. The governing decision is
[ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md); the firehose
mechanics are [ADR-035](../../adr/035-event-store-firehose-topic-exchange.md).

## The customer consent read/write slice

Two endpoints let a signed-in customer read and update their own channel-consent
record, both under `/api/auth/customer/me/consent`:

| Method | Route | Body | Returns |
| --- | --- | --- | --- |
| `GET` | `/api/auth/customer/me/consent` | — | the customer's `ConsentRecordView` |
| `PUT` | `/api/auth/customer/me/consent` | `{ transactionalEmail?, marketingEmail?, marketingSms?, dataRetentionPolicy? }` | the updated `ConsentRecordView` |

Both routes are **bearer-protected with no permission code**. Under the RBAC model
([ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)) a
customer's token carries no `permissions` claim, so a `@RequiresPermission(...)`
gate would reject every customer and be unreachable dead code. Instead the
authorization is **authentication plus inherent ownership**, exactly as the cart
and order customer routes work
([ADR-028](../../adr/028-cart-order-payment-and-address-chain.md)): the controller
folds the authenticated principal's id into the command, so a customer can only
ever read or write *their own* record. There is no route by which one customer can
reach another customer's consent.

The write is handled by `RecordConsentUseCase`, which loads the existing record
(or `ConsentRecord.default(customerId)` when the customer has none —
absent-row-means-defaults), overlays only the supplied keys (`apply(partial)` is
an upsert-merge), persists, and then emits `customer.consent.updated`.

The read is handled by `ReadConsentUseCase`. It is written as **owner-or-staff**
rather than customer-only: it takes `{ customerId, requesterId, isStaff }` and
allows the read when the requester is the owner *or* carries the staff override. A
non-owner without the override is rejected with `403`. The customer route always
passes `isStaff: false` with `requesterId === customerId`; writing the use case
owner-or-staff means the administrative consent-read endpoint (documented alongside
the erase flow below) can reuse it unchanged with `isStaff: true`. For that reason
`ReadConsentUseCase` is exported from the auth module.

## The two `customer.*` wire events

Both events are plain framework-free interfaces in `libs/contracts/auth/events/`
that extend `ICorrelationPayload` and add an `occurredAt` ISO-8601 string — the
wire-event convention ([ADR-011](../../adr/011-notifier-port-and-adapters.md)): a
domain object is never serialized across services, so the publisher maps the
persisted state onto the interface before emitting. Each pins an
`eventVersion: 'v1'` discriminator so a consumer can branch on a future schema
bump instead of guessing.

`ICustomerConsentUpdatedEvent` carries the **full** consent snapshot:

| Field | Type | Meaning |
| --- | --- | --- |
| `customerId` | string | The customer whose consent changed. |
| `transactionalEmail` | boolean | Consent to transactional email. |
| `marketingEmail` | boolean | Consent to marketing email. |
| `marketingSms` | boolean | Consent to marketing SMS. |
| `dataRetentionPolicy` | string | The retention-policy label. |
| `updatedAt` | string | ISO-8601 instant of the write (DB-stamped). |
| `eventVersion` | `'v1'` | Wire-shape discriminator. |
| `occurredAt` | string | ISO-8601 emit instant. |

It carries the whole snapshot on purpose: the notification service maintains a
consent cache to gate marketing sends, and shipping the complete record on the
event lets that cache **refresh itself from the event** without a per-refresh
cross-service RPC back to the gateway (the same "carry the data on the event"
choice the order-confirmation events make for the customer's email). A consumer
that only wants to invalidate can still key off `customerId`.

`ICustomerErasedEvent` carries only ids and the erase instant:

| Field | Type | Meaning |
| --- | --- | --- |
| `customerId` | string | The erased customer. |
| `erasedAt` | string | ISO-8601 erase instant (mirrors `customer.deleted_at`). |
| `actorStaffUserId` | string \| null | The staff user who erased, or null. |
| `eventVersion` | `'v1'` | Wire-shape discriminator. |
| `occurredAt` | string | ISO-8601 emit instant. |

### Two destinations: `notification_events` and `ris.events`

Both events are **dual-published**. The api-gateway `auth` module's
`RmqCustomerEventsPublisher` (the module's only holder of a RabbitMQ client, per
[ADR-009](../../adr/009-port-adapter-at-the-gateway.md)) sends each event to two
places:

1. A **primary emit onto `notification_events`** — the consumer's own queue, the
   producer-targets-consumer-queue pattern
   ([ADR-008](../../adr/008-rabbitmq-via-libs-messaging.md)/[ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)).
   This is what the notification consent consumers bind to; it needs no new
   exchange or binding.
2. A **mirror onto the `ris.events` topic exchange** — via the shared
   `RisEventsMirrorPublisher` (ADR-035), so the event-store firehose captures the
   stream into `domain_event` from its single `#` queue, again without re-binding
   any consumer.

Both emits are **best-effort and post-commit** ([ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)):
the consent record (or the tombstone) has already committed by the time the events
fire, so a broker hiccup must never surface to the caller. The primary emit is
wrapped here in a warn-log-and-swallow with a bounded timeout (a down broker leaves
the emit Observable *pending* rather than rejecting, so an unbounded wait would
otherwise hang the committed write); the mirror already owns that posture
internally. The mirror is ordered **after** the primary emit so a mirror failure
can never shadow the publish that feeds the real consumers, and the at-least-once
bus plus the firehose's idempotent ingest absorb any duplicate delivery.

## Why `customer.erased` carries no PII

The erase event is deliberately stripped of every personal field — no email, no
name, no phone, no address. Only the customer id, the erase instant, and the
acting staff user ride the wire. The reasoning is the whole point of the erase:

- **The event outlives the PII.** The firehose is an append-only log; a
  `customer.erased` row persists indefinitely in `domain_event`. If it carried the
  customer's email or name, that data would survive in the log **after** the erase
  was supposed to have destroyed it — the erasure would be defeated at the exact
  moment it was performed.
- **A downstream must never be able to reconstruct the erased identity** from the
  firehose. Publishing the identity alongside the announcement that it was erased
  would hand every consumer a permanent copy of the thing being erased.

So the contract inverts the usual "carry the data on the event" convenience: where
`customer.consent.updated` ships the full snapshot to save an RPC, `customer.erased`
ships the minimum, because here the data is precisely what must not travel. A
consumer that needs to act on the erasure (evict a cache entry, drop a projection)
keys off `customerId` alone.

## The erase audit row

Every erase is also recorded to the staff-action audit log, and — like the event —
that record captures **no PII**. `EraseCustomerUseCase` publishes it through the
real `AUDIT_LOG_PUBLISHER` (the `RmqAuditLogPublisher` that maps the in-process
`IAuditLogEvent` onto the `audit.staff.action` wire event and mirrors it onto
`ris.events`, where the event store persists it into `audit_log_entry` — ADR-035).
The published event is:

| Field | Value |
| --- | --- |
| `name` | `'CustomerErased'` |
| `actorId` | the erasing staff user's id |
| `actorKind` | `'staff'` |
| `targetKind` / `targetId` | `'customer'` / the erased customer id |
| `payload.before` | `{ id, status }` — the pre-erase state |
| `payload.after` | `{ status: 'deleted' }` |

The `before`/`after` is a **state-only** projection: `{ id, status }` before the
erase and `{ status: 'deleted' }` after, with the customer id as the audited entity
and no email, name, or address anywhere in the payload. This keeps the audit trail
answering "who erased which customer and when" without itself becoming a surviving
copy of the data the erase destroyed — capturing the PII here would defeat the erase
at the exact moment it was performed, exactly as it would in the event payload.

The audit is published **after** the erase transaction commits and **before** the
`customer.erased` fan-out event (the audit is the compliance record and is ordered
first); both are best-effort, so a broker outage can never roll back a completed
erase. The full tombstone mechanics — the `Customer.erase()` mutator, the
one-transaction cross-context PII-nulling writer, the confirm-email guard, and the
admin endpoint — are documented in
[02-erase-customer-q6.md](02-erase-customer-q6.md) and
[05-confirm-email-guard.md](05-confirm-email-guard.md).

## Related decisions

- [ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md) — the governing
  decision for the whole consent-and-erasure capability, including the no-PII rule
  for events and audit.
- [ADR-035](../../adr/035-event-store-firehose-topic-exchange.md) — the `ris.events`
  topic-exchange firehose and the `RisEventsMirrorPublisher` dual-publish the
  `customer.*` events reuse.
- [ADR-028](../../adr/028-cart-order-payment-and-address-chain.md) — the customer
  routes' auth-plus-ownership model the consent endpoints follow.
- [ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md) — why the
  customer consent write path uses no permission code.
