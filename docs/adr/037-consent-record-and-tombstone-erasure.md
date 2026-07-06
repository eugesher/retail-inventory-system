# ADR-037: ConsentRecord and tombstone-based customer erasure

- **Date**: 2026-07-04
- **Status**: Accepted

---

## Context

The identity model has a `Customer` aggregate whose row carries personally
identifiable information (email, phone, name) and whose id is the **nullable** FK
target of `order.customer_id` — the nullable FK was chosen up front so that a
deleted customer could leave an order tombstone rather than cascade-delete the
sales record ([ADR-028](028-cart-order-payment-and-address-chain.md) §1,
[ADR-024](024-rbac-v2-staffuser-customer-and-permissions.md)). Two capabilities
were still missing:

1. **A privacy-erasure path** (the GDPR "right to be forgotten" posture). A
   customer must be able to have their PII removed while the historical order
   record — which references their id — stays intact and auditable. Today the
   `Customer` model's constructor enforces an **unconditional** "email must be a
   valid email address" invariant and the `customer.email` column is **NOT NULL**,
   so the model and schema literally cannot *represent* an erased customer. The
   `address` PII columns are likewise NOT NULL.

2. **A consent record** for notification channels. Transactional mail (order
   confirmations) is operationally required, but marketing mail/SMS is opt-in
   under a privacy regime, and there is nowhere to store a customer's channel
   preferences or their data-retention policy.

This ADR decides the **whole** consent-and-erasure capability — the
`ConsentRecord` aggregate, tombstone-based erasure, session revocation, the
notification consent-gate, and the no-PII-in-events/audit rule — in **one
record**, following the precedent that one ADR fixes a capability whose code
lands across several changes ([ADR-030](030-reservation-ttl-aggregate-and-stock-movement-ledger.md) /
[ADR-033](033-notification-templates-deliveries-and-render-dispatch.md) /
[ADR-036](036-idempotency-key-store-and-enforced-occ.md)). The tombstone-ready
schema + model, the `ConsentRecord` persistence, and the two RBAC codes land
first; the `erase()` mutator + Erase use case + erasure writer, the consent
Record/Read operations + events, and the notification gate land in follow-up
changes.

## Decision

### 1. `ConsentRecord` — a 1:1, channel-consent aggregate keyed on the customer id

A `ConsentRecord` holds one customer's notification-channel consent plus a
data-retention policy label:

- `transactional_email` — **default true**. Order-confirmation-style mail is
  operationally required; it is the *transactional bypass* the notification gate
  honors (transactional email is gated only by this flag, never by a marketing
  flag).
- `marketing_email`, `marketing_sms` — **default false** (opt-in — the GDPR
  posture).
- `data_retention_policy` — a free-form label (`default-7-years`), so operators
  can introduce new retention regimes without a schema change.

It is **1:1 with `Customer`**, keyed on the customer's `CHAR(36)` UUID as the
**primary key** with a FK → `customer(id)` `ON DELETE CASCADE`. The entity does
**not** extend `BaseEntity`: there is no surrogate auto-increment id, no
`version`, no `created_at` / `deleted_at` — only `updated_at`. This is the
no-`BaseEntity`, caller-assigned-PK precedent of `idempotency_key` /
`domain_event` ([ADR-036](036-idempotency-key-store-and-enforced-occ.md) /
[ADR-034](034-isolated-eventstore-database.md)). It records **no** domain events
(the `Category` / `NotificationTemplate` precedent —
[ADR-029](029-category-materialized-path-and-polymorphic-media.md) /
[ADR-033](033-notification-templates-deliveries-and-render-dispatch.md); the
consent use cases emit `customer.consent.updated` themselves).

**Absent-row-means-defaults.** A customer with no stored row resolves to
`ConsentRecord.default(customerId)` — all defaults, no `updated_at`. So an absent
row and an all-defaults row are indistinguishable downstream; the Read path and
the notification gate never special-case "no row". Writes are an **upsert-merge**
(`apply(partial)` overlays only the supplied keys), so a customer PATCHing just
`marketingEmail` leaves the other channels untouched.

The `ON DELETE CASCADE` means consent dies with the customer row **should it ever
be hard-deleted** — but per the erase decision below the row is **never**
hard-deleted; the CASCADE is a documented safety net. A `ConsentRecord` is itself
hard-deletable after a retention window, but that purge is not part of this
capability.

### 2. Tombstone-based erasure — null the PII, preserve the id

Erasing a customer is a **tombstone**, never a hard delete:

- **Null the customer PII columns** (`email`, `phone`, `first_name`,
  `last_name`, `password_hash`, `email_verified_at`) while **preserving `id`**, so
  every `order.customer_id` FK stays valid and the sales history is intact.
- **Flip `status = 'deleted'`** and **set `deleted_at`** to the erase instant.
- **Clear `refresh_token_hash`** — a **session revocation**: the customer's live
  refresh token can no longer roll forward, and the `existsAuthenticatableById`
  check (`status IN ('active','guest')`) already bars a `deleted` row from
  authenticating.
- **Null the customer's `owner_type = 'customer'` address PII** (the reusable
  address-book rows). **Order-snapshot addresses (`owner_type = 'order'`) are
  immutable and untouched** — they are a frozen place-time record of where an
  order shipped, part of the sales history, not the customer's live PII
  ([ADR-028](028-cart-order-payment-and-address-chain.md) §5).
- **Abandon the customer's carts** (a `Cart` is a disposable working set, not a
  record to preserve).
- Erase is **idempotent** on an already-`deleted` customer (re-erasing is a no-op).

For this to be *representable*, three cleanup-first schema/model changes are
required and are made here:

- `customer.email` becomes **nullable**; a `customer.deleted_at` column is added.
  The other customer PII columns are already nullable.
- The five `address` PII columns (`recipient_name` / `line1` / `city` / `region`
  / `postal_code`) become **nullable** (`line2` / `phone` already are).
- The `Customer` model's unconditional email invariant is **removed and replaced**
  by a **status-conditional** one: a live customer (any status other than
  `deleted`) MUST carry a syntactically valid email; a `deleted` customer may have
  a null email. The old rule is deleted, not renamed. The email nullability is
  **contained to the domain model + persistence** — it does not leak into the
  authenticated-session contracts (`IJwtAccessPayload.email`, `ICurrentUser.email`,
  the `GET /me` response), because a tombstoned customer cannot hold a session
  (the guards reject it).

### 3. Cross-service PII nulling via a gateway-owned raw-SQL erasure writer

The customer's PII spans two bounded contexts in the shared `retail_db`: the
gateway `auth` module owns `customer`, and the retail `orders` module owns
`address` / `cart`. Erasure nulls both in **one transaction** through a
**gateway-owned raw-SQL erasure writer** (`CUSTOMER_ERASURE_WRITER`) that issues
parameterized `UPDATE`s against the `address` / `cart` tables **without importing
the retail entities** — the `ORDER_CART_READER` / `RETURN_ORDER_READER`
cross-context reader-port precedent ([ADR-028](028-cart-order-payment-and-address-chain.md)
/ [ADR-032](032-returns-and-refunds-rma-lifecycle-and-restock.md)), applied to a
write. One transaction gives the erase atomicity and a single auditable erase
site.

*Alternative rejected: event-driven retail-side nulling* — emit `customer.erased`
and have retail null its own `address` / `cart` rows in a consumer. Rejected: it
is non-atomic (the customer row is tombstoned before retail reacts, leaving a
window where PII is half-erased) and unauditable at the erase site (the operator
who ran the erase cannot see, in one place, that all PII was nulled).

### 4. No PII in event payloads or audit rows

Erasure that leaves PII in an **event payload** or an **audit row** defeats
itself — the firehose and the audit log are exactly the durable, replicated,
hard-to-purge stores a "right to be forgotten" must not seed with the data it is
removing. Therefore:

- The `customer.erased` event carries **only** `customerId` / `erasedAt` /
  `actorStaffUserId` — never the nulled PII.
- The `AUDIT_LOG_PUBLISHER` before/after for an erase is `{ id, status }` →
  `{ status: 'deleted' }` — the state transition, not the data removed.

### 5. `customer.*` events ride the existing fan-out

`customer.consent.updated` and `customer.erased` are emitted onto
`notification_events` (the producer-targets-consumer-queue convention,
[ADR-008](008-rabbitmq-via-libs-messaging.md) /
[ADR-020](020-rabbitmq-as-inter-service-bus.md)) and **mirrored** onto the
`ris.events` topic exchange via the shared `RisEventsMirrorPublisher` for the
event-store firehose ([ADR-035](035-event-store-firehose-topic-exchange.md)). No
new topic-exchange binding and **no second `ris.events` consumer queue** are
introduced — the event store's single `#`-bound firehose queue already captures
them.

### 6. Notification consent-gate

The notification service gates marketing dispatch on the customer's consent. It
reads consent through a **notification-side raw-SQL `CONSENT_READER`** over the
shared `consent_record` table (the cross-context reader-port precedent again — no
gateway import), **cache-aside** under `ris:notifications:consent:v1:<customerId>`
with `singleFlight` miss-dedupe ([ADR-021](021-cache-single-flight-and-ttl-jitter.md)),
the cache **refreshed by `customer.consent.updated`** and **cleared by
`customer.erased`**. The **transactional-channel bypass rule**: a transactional
email is gated only by `transactionalEmail`; a marketing email/SMS by
`marketingEmail` / `marketingSms`. A dispatch suppressed by the gate is recorded
as a new **`skipped-no-consent`** terminal delivery status (auditable, not a
silent drop).

### 7. Two new permission codes, not three

Two `PermissionCodeEnum` codes are added — **`customer:read-consent`** and
**`customer:erase`** — both **admin-only staff overrides** (they auto-bind to the
`admin` role, which seeds `Object.values(PermissionCodeEnum)`). There is
deliberately **no** `customer:own-consent:write` (or any customer-facing consent
code): per [ADR-024](024-rbac-v2-staffuser-customer-and-permissions.md) /
[ADR-028](028-cart-order-payment-and-address-chain.md) a customer JWT carries no
`permissions` claim, so a `@RequiresPermission('customer:…')` gate would be
**unreachable-by-construction dead code** — it would reject the very customers it
targets. The customer consent write path is authorized by **authentication +
inherent ownership** (the use case folds the authenticated principal's id into the
command, as the cart/order customer routes do); a permission code is a *staff
override* over an owner-check, never a customer gate.

## Alternatives Considered

- **A customer-facing consent permission code** (`customer:own-consent:write`).
  Rejected: customer tokens carry no `permissions` claim
  ([ADR-024](024-rbac-v2-staffuser-customer-and-permissions.md)), so the gate is
  unreachable dead code. Authentication + ownership is the customer authorization
  model ([ADR-028](028-cart-order-payment-and-address-chain.md)).
- **Hard-delete of the `Customer` row** on erasure. Rejected: it orphans the
  `order.customer_id` FK (a `RESTRICT` blocks the delete; a `CASCADE` would erase
  the sales history). The nullable-FK tombstone preserves the record while
  removing the PII — the whole reason the FK was made nullable
  ([ADR-028](028-cart-order-payment-and-address-chain.md) §1).
- **PII in the event / audit payloads.** Rejected: it re-seeds the durable,
  replicated firehose and audit log with the exact data the erase removes. Events
  and audit rows carry ids + state transitions only.
- **Event-driven cross-service PII nulling.** Rejected: non-atomic and
  unauditable at the erase site (see §3). A single-transaction raw-SQL writer is
  atomic and centralizes the erase.
- **A second `ris.events` consumer queue** for `customer.*` events. Rejected: the
  event store's single `#`-bound firehose queue already captures every mirrored
  event ([ADR-035](035-event-store-firehose-topic-exchange.md)); a second queue
  buys nothing and one Nest app cannot cleanly bind disjoint pattern sets across
  two transports.

## Consequences

- The `customer.email` and five `address` PII columns become nullable, and
  `customer.deleted_at` is added, in one additive migration; `consent_record` is
  created in the same migration ([ADR-019](019-typeorm-and-mysql-for-persistence.md);
  `synchronize` off, no production data). The migration `down` restores the NOT
  NULL constraints (which only succeeds on no-null, pre-erase data — acceptable
  for a `down`).
- The `Customer` model's email invariant is now status-conditional; the model can
  rehydrate a `status='deleted'` row with null PII. The nullability is contained
  to the domain + persistence and never surfaces in a session contract.
- `ConsentRecord` (model + entity + mapper + repository), the
  `CONSENT_RECORD_REPOSITORY` port, and the `ConsentRecordView` contract land now;
  `customer:read-consent` / `customer:erase` are registered and seed to `admin`.
- The `erase()` mutator + Erase use case + `CUSTOMER_ERASURE_WRITER`, the consent
  Record/Read use cases + `customer.consent.updated` / `customer.erased` events,
  the notification `CONSENT_READER` + cache-aside gate + `skipped-no-consent`
  status, and the seed row land across follow-up changes.

## References

- [ADR-024](024-rbac-v2-staffuser-customer-and-permissions.md) — the `StaffUser` /
  `Customer` split, the `PermissionCodeEnum` registry as the single source of
  truth, and the customer-JWT-carries-no-`permissions` rule that forces two codes,
  not three.
- [ADR-028](028-cart-order-payment-and-address-chain.md) — the nullable
  `order.customer_id` FK (the tombstone rationale), the immutable
  `owner_type='order'` address snapshots, and the authentication-plus-ownership
  customer authorization model.
- [ADR-033](033-notification-templates-deliveries-and-render-dispatch.md) — the
  notification delivery model this extends with a `skipped-no-consent` status and
  a consent gate; the "no domain events; the use case emits" precedent.
- [ADR-035](035-event-store-firehose-topic-exchange.md) — the `ris.events` mirror
  the `customer.*` events ride; the single firehose queue that makes a second
  consumer queue unnecessary.
- [ADR-036](036-idempotency-key-store-and-enforced-occ.md) /
  [ADR-034](034-isolated-eventstore-database.md) — the no-`BaseEntity`,
  caller-assigned-PK, `updated_at`-only entity shape `consent_record` follows.
- [ADR-019](019-typeorm-and-mysql-for-persistence.md) — TypeORM + MySQL,
  hand-authored migrations, `synchronize` off.
- [ADR-021](021-cache-single-flight-and-ttl-jitter.md) — the `singleFlight` cache-aside
  the notification consent gate uses.
