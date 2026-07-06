# The ConsentRecord aggregate and the tombstone-ready identity schema

A retail system that sends customers email and SMS, and that must be able to
honor a "right to be forgotten" request, needs two things its identity model did
not have: a place to store **who consented to which channels**, and the ability
to **erase a customer's personal data without destroying the sales record** that
references them. This document introduces the foundation for both — the
`ConsentRecord` aggregate and the schema/model changes that make an erased
customer *representable* — and explains the reasoning behind each choice. The
governing decision is
[ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md).

This is the first slice of a larger capability. It ships the data model, the
persistence, and the access-control codes; the behaviors that consume them (the
`erase()` operation, the consent Record/Read endpoints, the events, and the
notification-side gate) land in follow-up changes and are noted as forward
references where relevant.

## What a ConsentRecord is

A `ConsentRecord` is one customer's notification-channel consent, plus a
data-retention policy label. It has four meaningful fields and one timestamp:

| Field | Type | Meaning |
| --- | --- | --- |
| `transactionalEmail` | boolean | Consent to order-confirmation-style mail. |
| `marketingEmail` | boolean | Consent to marketing email. |
| `marketingSms` | boolean | Consent to marketing SMS. |
| `dataRetentionPolicy` | string | A free-form retention-policy label (`default-7-years`). |
| `updatedAt` | timestamp | When the record was last written (DB-stamped). |

It is **1:1 with a `Customer`** — one row per customer, no more — so it is keyed
directly on the customer's `CHAR(36)` UUID: `consent_record.customer_id` is both
the **primary key** and a foreign key to `customer(id)`. There is no separate
surrogate id.

Because a consent row's identity *is* the customer id, and because it carries no
lifecycle beyond "last written", the entity deliberately does **not** extend the
shared `BaseEntity`. It has no auto-increment id, no optimistic-lock `version`,
and no `created_at` / `deleted_at` — only `updated_at`. This is the same
append-style, no-`BaseEntity` shape used by the idempotency store and the
event-store tables ([ADR-036](../../adr/036-idempotency-key-store-and-enforced-occ.md),
[ADR-034](../../adr/034-isolated-eventstore-database.md)): when a row's key is a
natural identifier and its history is not needed, the `BaseEntity` columns are
noise.

The domain model (`ConsentRecord`) is a plain, framework-free class — the
`StockLevel` / `Reservation` style, not an event-sourced aggregate root. It
records **no** domain events; the consent use cases (later work) emit
`customer.consent.updated` themselves. It exposes three construction/mutation
entry points:

- `ConsentRecord.default(customerId)` — the all-defaults record a customer with
  no stored row resolves to.
- `ConsentRecord.rehydrate(customerId, props)` — the load path.
- `record.apply(partial)` — an **upsert-merge**: it overlays only the keys the
  caller supplied, so a customer changing just their marketing-email preference
  leaves the other channels untouched.

The FK is declared `ON DELETE CASCADE`. That means a consent row would die with
its customer **if the customer row were ever hard-deleted** — but, as the erasure
model below explains, the customer row is *never* hard-deleted. The CASCADE is a
documented safety net, not a path the system actually takes.

## Why transactional defaults to true and marketing to false

The two categories of message have opposite default postures, and the defaults
encode a deliberate privacy stance:

- **Transactional email defaults to `true`.** Order confirmations, shipping
  notices, and refund receipts are *operationally required* — a customer who buys
  something needs to be told it shipped. Consent to these is assumed and can be
  withdrawn, not opted into.
- **Marketing email and SMS default to `false`.** Promotional messaging is
  **opt-in** — the posture a modern privacy regime expects. A customer receives
  marketing only after affirmatively enabling it.

A crucial consequence of the 1:1-with-defaults design: **an absent row means the
defaults**. A customer who has never touched their consent settings has no
`consent_record` row at all, and both the read path and the notification gate
resolve that to `ConsentRecord.default(customerId)`. An absent row and an
all-defaults row are therefore indistinguishable downstream — no code has to
special-case "this customer has no consent row yet".

### The transactional-channel bypass rule (forward reference)

These defaults set up a rule the notification side will enforce in a follow-up
change: a **transactional** email is gated only by `transactionalEmail`, while a
**marketing** email or SMS is gated by `marketingEmail` / `marketingSms`. So a
customer who has opted out of all marketing still receives their order
confirmations — the transactional channel *bypasses* the marketing flags. The
notification-side reader, cache, and gate that implement this are later consent
work; this document only establishes the fields and defaults they read.

## The tombstone-ready schema change

The second half of this foundation makes it *possible* to erase a customer. The
identity model was built so that deleting a customer would leave an **order
tombstone** — `order.customer_id` is a **nullable** FK precisely so the sales
record survives a customer's removal
([ADR-028](../../adr/028-cart-order-payment-and-address-chain.md) §1). But two
constraints still made an erased customer impossible to *represent*:

1. **`customer.email` was `NOT NULL`**, and the `Customer` model enforced an
   **unconditional** "email must be a valid email address" invariant. An erased
   customer has no email — so neither the column nor the model could hold that
   state.
2. **The `address` PII columns** (`recipient_name`, `line1`, `city`, `region`,
   `postal_code`) were `NOT NULL`, so a customer's reusable address rows could not
   be nulled.

This change relaxes exactly those constraints and adds the tombstone marker:

- `customer.email` becomes **nullable**. (The other customer PII columns —
  `phone`, `first_name`, `last_name`, `password_hash`, `email_verified_at` — were
  already nullable.)
- A `customer.deleted_at` (nullable `TIMESTAMP`) column is added — the tombstone
  marker, set to the erase instant. It is a domain-meaningful erase timestamp,
  distinct from the inert `BaseEntity.deletedAt` soft-delete convention (the
  `customer` table does not extend `BaseEntity`).
- The five `address` PII columns become **nullable** (`line2` / `phone` already
  were).

Correspondingly, the `Customer` model's email invariant is **removed and
replaced** by a **status-conditional** one: a live customer (any status other
than `deleted`) must carry a syntactically valid email, but a `deleted` customer
may have a null email. The old unconditional rule is deleted outright, not renamed
or flagged — a `deleted` customer now rehydrates cleanly with null PII, while a
live customer still rejects a malformed email exactly as before.

One subtlety worth calling out: the email nullability is **contained to the
domain model and persistence**. It does not widen the authenticated-session
contracts — the JWT access payload, the current-user shape, and the `GET
/auth/customer/me` response still type `email` as a non-null string. That is
correct, not an oversight: a tombstoned customer *cannot hold a session* (login
requires a password the erase cleared, and the per-request subject check bars a
`deleted` status), so no authenticated code path ever observes a null email. The
nullability lives exactly where the tombstone lives — in the stored row — and
nowhere else.

The `consent_record` table, the `customer` changes, and the `address` changes all
land in one additive migration, with a `down` that restores the `NOT NULL`
constraints (which succeeds on pre-erase, no-null data). `synchronize` stays off;
the migration is the source of truth for the schema
([ADR-019](../../adr/019-typeorm-and-mysql-for-persistence.md)).

## Access control: two staff codes, and deliberately no customer code

Two permission codes are added to the registry:

- **`customer:read-consent`** — read any customer's consent record.
- **`customer:erase`** — erase (tombstone) a customer and their PII.

Both are **admin-only staff overrides**. They bind automatically to the `admin`
role, which is seeded with every code in the registry; no other seeded role
receives them.

What is *not* added is just as deliberate: there is **no** customer-facing consent
permission code (no `customer:own-consent:write` or similar). Under the RBAC model
([ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)) a
customer's JWT carries **no `permissions` claim** — permission codes are inflated
only into staff tokens. A route guarded by `@RequiresPermission('customer:…')`
would therefore reject every customer, making a customer-facing consent code
unreachable-by-construction dead code. The customer's own consent write path is
instead authorized the way the cart and order customer routes are
([ADR-028](../../adr/028-cart-order-payment-and-address-chain.md)): by
**authentication plus inherent ownership** — the use case folds the authenticated
principal's id into the command and acts only on that customer's own record. A
permission code is a *staff override* over an ownership check, never a gate on the
owning customer themselves.

## What lands later

To keep the boundary explicit, these pieces are **not** in this foundation and
arrive in follow-up consent work:

- The `Customer.erase()` mutator, the Erase use case, and the cross-context
  raw-SQL erasure writer that nulls the `address` / `cart` PII in one transaction.
- The consent Record/Read use cases and their gateway endpoints, and the
  `customer.consent.updated` / `customer.erased` events.
- The notification-side consent reader, its cache-aside gate, and the
  `skipped-no-consent` delivery status.
- The seed `consent_record` row and the marketing template.

## Related decisions

- [ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md) — the governing
  decision for the whole consent-and-erasure capability.
- [ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md) — the RBAC
  model that makes the customer consent write path auth-plus-ownership, not a
  permission code.
- [ADR-028](../../adr/028-cart-order-payment-and-address-chain.md) — the nullable
  `order.customer_id` tombstone FK and the immutable order-address snapshots the
  erase preserves.

## Related documents

- [02 — Erasing a customer: the tombstone, not a hard delete](02-erase-customer-q6.md) —
  the `erase()` mutator, the one-transaction erasure writer, and the tombstone
  semantics this schema makes representable.
- [03 — The notification consent-gate](03-consent-event-and-cache.md) — how the
  `ConsentRecord` defined here gates marketing dispatch, read cache-aside.
- [04 — The customer privacy events and the no-PII erase contract](04-customer-erased-event-and-pii.md) —
  the `customer.consent.updated` / `customer.erased` wire events.
- [06 — The consent, erasure, and marketing HTTP surface](06-consent-and-erase-api-and-http-files.md) —
  the operator's-eye view of the endpoints and the request libraries.
