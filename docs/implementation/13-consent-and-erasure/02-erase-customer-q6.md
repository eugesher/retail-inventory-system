# Erasing a customer: the tombstone, not a hard delete

The system lets an administrator erase a customer's personal data — the "right to
be forgotten" posture. The design question this document answers is **how** that
erase is performed given that a customer's id is referenced by immutable sales
records: **erasure is a tombstone, never a hard delete.** The customer row is kept
as `{ id, status: 'deleted', deletedAt }` with every PII column nulled, so the
historical order record that references the id stays intact and auditable while the
personal data it once pointed at is destroyed. The governing decision is
[ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md); the nullable-FK
chain it relies on is
[ADR-028](../../adr/028-cart-order-payment-and-address-chain.md).

## Why a tombstone and not a hard delete

`order.customer_id` is a **nullable** foreign key to `customer(id)` — a shape chosen
up front precisely so a customer could be erased without cascade-deleting their
sales history ([ADR-028](../../adr/028-cart-order-payment-and-address-chain.md) §1).
A hard delete of the `customer` row is therefore the wrong tool:

- With the FK `ON DELETE RESTRICT`, the delete is simply **blocked** the moment the
  customer has ever placed an order.
- With an `ON DELETE CASCADE`, it would **erase the sales record itself** — orders,
  payments, refunds — which is unacceptable: those rows are needed for tax filing,
  chargeback/dispute handling, and accounting long after a customer leaves.

The tombstone resolves the tension. The row survives (so every `order.customer_id`
FK still resolves and the sales history is whole), but it no longer carries any
personal data. What is preserved is a bare identity marker — `id`, `status`,
`deletedAt` — not a person.

## What is nulled, and what is not

The erase nulls PII in two places, abandons a third, and deletes the consent
record, all in one transaction.

**The `customer` row** — every PII column is nulled and the row is flipped to the
tombstone state:

| Column | After erase |
| --- | --- |
| `email` | `NULL` |
| `phone` | `NULL` |
| `first_name` | `NULL` |
| `last_name` | `NULL` |
| `password_hash` | `NULL` |
| `email_verified_at` | `NULL` |
| `refresh_token_hash` | `NULL` (see *Session revocation*) |
| `status` | `'deleted'` |
| `deleted_at` | the erase instant |
| `id` | **preserved** |

**The customer's address-book rows** (`address` where `owner_type = 'customer'`) —
the five originally-non-null PII columns plus the two already-nullable ones are
nulled: `recipient_name`, `line1`, `line2`, `city`, `region`, `postal_code`,
`phone`. The `country` column is **kept** — a two-letter region code is not
identifying on its own, and retaining it keeps aggregate geographic reporting
possible. There are zero such rows today (no address-book write path exists yet),
but the erase nulls them for correctness the moment that path lands.

**What is deliberately NOT erased:**

- **`owner_type = 'order'` address snapshots.** When an order is placed, the
  shipping/billing address is copied into an **immutable** `address` row owned by the
  *order*, not the customer ([ADR-028](../../adr/028-cart-order-payment-and-address-chain.md)
  §5). That snapshot is a frozen place-time record of where a specific order shipped
  — part of the sales history, not the customer's live PII — and the erase writer's
  `WHERE owner_type = 'customer'` clause never touches it.
- **Orders, payments, refunds.** The whole point of the tombstone is to keep these.

## Session revocation

Clearing `refresh_token_hash` is a **session revocation**. Refresh tokens rotate on
every use and the server stores only the hash of the currently-valid one
([ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)); nulling it
means any refresh token the erased customer still holds can no longer roll forward —
presenting it clears/leaves no matching hash and the refresh is rejected with `401`.
Independently, the per-request JWT validator's `existsAuthenticatableById` check
already admits only `status IN ('active','guest')`, so a `deleted` row cannot
authenticate at all. The two together mean the erase takes effect on the session
layer immediately, not just on the stored data.

## Cart abandonment (Q1)

The customer's **active carts** are flipped to `status = 'abandoned'`. A `Cart` is a
disposable working set, not a record to preserve, so there is nothing to keep — but
the FK is **left intact** (not nulled) so the tombstone customer row still resolves
from the cart. This mirrors the existing cart lifecycle, which already retires carts
by status (`abandoned` / `converted`) rather than deleting them.

## The atomic cross-table erasure writer

A customer's PII spans **two bounded contexts** in the shared `retail_db`: the
gateway `auth` module owns the `customer` table, while the retail modules own
`address` and `cart`. The erase nulls all of it in **one transaction** through a
gateway-owned raw-SQL writer, `CUSTOMER_ERASURE_WRITER`.

The writer runs four statements inside a single `manager.transaction(...)`:

1. Persist the erased `customer` aggregate (through the auth module's own mapper —
   the `customer` table is the module's own, so its column mapping stays in one
   place).
2. `UPDATE address … WHERE owner_type = 'customer' AND owner_id = ?` — null the
   address-book PII.
3. `UPDATE cart SET status = 'abandoned' … WHERE customer_id = ? AND status =
   'active'` — abandon the active carts.
4. `DELETE FROM consent_record WHERE customer_id = ?` — remove the customer's
   channel-consent record. Consent preferences are themselves personal data, so a
   right-to-erasure must clear them; and because the customer row is tombstoned
   (never hard-deleted), the `consent_record` FK's `ON DELETE CASCADE` never fires,
   so the row would otherwise survive the erase. Deleting it (rather than resetting
   the flags) is what makes a later consent read fall through to the absent-row
   defaults (transactional on, marketing **off**) — exactly what the
   `customer.erased` cache-eviction consumer relies on to stop an erased customer's
   marketing sends. `consent_record` is the `auth` module's own table, so — like
   statement 1 — it is reached through its repository, not raw SQL. (This statement
   was added in the same-epic review pass after the first erase slice shipped, which
   is why some sibling prose still describes only the customer/address/cart writes.)

Statements 2 and 3 reach tables the `auth` module does **not** own. Rather than
import the retail `AddressEntity` / `CartEntity` — which the architecture
boundaries forbid ([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)) — the
writer issues **parameterized SQL through the injected `EntityManager`**, binding
the opaque shared FK values (`customer.id`) as `?` placeholders. This is the
cross-context reader-port precedent (`ORDER_CART_READER` / `RETURN_ORDER_READER`,
[ADR-028](../../adr/028-cart-order-payment-and-address-chain.md) /
[ADR-032](../../adr/032-returns-and-refunds-rma-lifecycle-and-restock.md)), applied
to a **write**.

The single transaction buys two things:

- **Atomicity.** The customer row and all downstream PII are nulled together or not
  at all — there is no window in which the customer is tombstoned but their address
  PII survives.
- **A single auditable erase site.** The operator who ran the erase can see, in one
  place, that every PII surface was nulled.

**Why not event-driven?** The rejected alternative was to emit `customer.erased` and
let each retail context null its own rows in a consumer. That is *non-atomic* (the
customer is tombstoned before retail reacts, leaving a half-erased window) and
*unauditable at the erase site* (the erase operator cannot confirm, in one place,
that the downstream PII was actually removed). The single-transaction raw-SQL writer
is both atomic and centralized. The `customer.erased` event is still emitted — but
as a *notification* for caches and projections
([04-customer-erased-event-and-pii.md](04-customer-erased-event-and-pii.md)), not as
the mechanism that performs the retail-side nulling.

## The erase sequence

`EraseCustomerUseCase` orchestrates the erase behind three gates, so no side effect
runs until the request is proven valid:

1. **Load** the customer via `CUSTOMER_REPOSITORY`. Not found → `404`.
2. **Idempotency.** If the customer is already `status = 'deleted'`, return the
   existing tombstone `{ status: 'deleted', erasedAt: <existing deletedAt> }` with
   **no** re-audit, re-emit, or second write. The confirm-email guard is skipped
   here — there is no PII left to guard (see below and
   [05-confirm-email-guard.md](05-confirm-email-guard.md)).
3. **Confirm-email guard.** The operator must type the customer's **current** email;
   it is compared case-insensitively and a mismatch is a `400` with nothing written
   ([05-confirm-email-guard.md](05-confirm-email-guard.md)).
4. Capture a **PII-free before-snapshot** `{ id, status }` for the audit.
5. `customer.erase(now)` nulls the PII in the aggregate.
6. `CUSTOMER_ERASURE_WRITER.persistErasure(customer)` runs the one-transaction
   customer + address + cart writes above.
7. **Audit** through `AUDIT_LOG_PUBLISHER` — before `{ id, status }`, after
   `{ status: 'deleted' }`, **no PII**
   ([04-customer-erased-event-and-pii.md](04-customer-erased-event-and-pii.md)).
8. **Emit** `customer.erased` — ids + `erasedAt` only, **no PII**.

Steps 7 and 8 run **after** the transaction commits and are best-effort: a broker
outage must never roll back a completed erase. The audit is ordered before the emit
because it is the compliance record.

## Idempotency

Erase is **idempotent on an already-deleted customer** (last-writer-wins). Re-running
the erase against a `deleted` row is a no-op success: it returns the existing
tombstone and performs no second write, audit, or emit. This makes the endpoint safe
to retry (a client timeout, a double-click) without producing duplicate audit rows or
duplicate `customer.erased` events, and it is the reason the confirm-email guard is
skipped on the short-circuit branch — a tombstone has no email to confirm against.

## The admin surface

The erase and the administrative consent-read are fronted by a thin
`customer-admin` gateway module — a presentation-and-orchestration shell with **no
`domain/` of its own**, the `iam` module pattern
([ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)). It imports
the `auth` module and injects the two use cases `auth` exports; the domain mutation
stays in the module that owns the `Customer` aggregate.

| Method | Route | Permission | Body | Returns |
| --- | --- | --- | --- | --- |
| `GET` | `/api/admin/customers/:id/consent` | `customer:read-consent` | — | `ConsentRecordView` |
| `POST` | `/api/admin/customers/:id/erase` | `customer:erase` | `{ confirmEmail }` | `{ status: 'deleted', erasedAt }` |

Both permissions are **admin-only staff overrides** — they auto-bind to the `admin`
role, which seeds every code in the registry. There is deliberately **no**
customer-facing erase or consent-write permission code: a customer JWT carries no
`permissions` claim, so a `@RequiresPermission('customer:…')` gate would be
unreachable-by-construction dead code
([ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md) §7). The
consent-read endpoint reuses the owner-or-staff `ReadConsentUseCase` unchanged,
passing `isStaff: true`.

## Related decisions

- [ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md) — the governing
  decision: tombstone erasure, the gateway-owned raw-SQL erasure writer, no PII in
  events/audit, the two admin-only permission codes.
- [ADR-028](../../adr/028-cart-order-payment-and-address-chain.md) — the nullable
  `order.customer_id` FK that makes the tombstone possible, and the immutable
  `owner_type='order'` address snapshots the erase must never touch.
- [ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md) — the
  admin-shell (`iam`) module pattern, the session-revoke semantics, and why the
  erase uses a staff permission code rather than a customer one.
