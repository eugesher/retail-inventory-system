# The confirm-email guard on customer erasure

Erasing a customer is **irreversible**: it nulls the customer's PII across the
`customer`, `address`, and `cart` tables in one transaction, and there is no undo.
An action with that blast radius should not be a single unguarded button. The
confirm-email guard is the deliberate friction that turns the erase into a
two-factor confirmation. The governing decision is
[ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md); the full erase
flow is [02-erase-customer-q6.md](02-erase-customer-q6.md).

## What the guard is

The `POST /api/admin/customers/:id/erase` request carries a `confirmEmail` field.
Before nulling anything, `EraseCustomerUseCase` compares it against the target
customer's **current** email. The operator must type the email of the exact
customer they intend to erase; a value that does not match aborts the request.

```
POST /api/admin/customers/{id}/erase
{ "confirmEmail": "buyer@example.com" }
```

The id in the path selects **which** customer; the email in the body **proves the
operator knows which customer that is**. The two must agree. Because the path id and
a re-typed identifier have to line up, an erase triggered against the wrong id — a
mis-paste, a stale bookmark, the wrong row in an admin list — fails instead of
destroying the wrong person's data.

## The comparison, and where it runs

- **Case-insensitive.** The `Customer` model lower-cases the stored email, and the
  guard lower-cases (and trims) the submitted value before comparing, so
  `Buyer@Example.com` matches a stored `buyer@example.com`. The operator is
  confirming an identity, not a byte-for-byte string.
- **Before any nulling.** The guard is the third gate in the sequence — after
  not-found and after the idempotency short-circuit, but **before** the
  before-snapshot and `customer.erase()`. It has to run first because the stored
  email is exactly the value it compares against; once the erase nulls the email
  there is nothing left to confirm.
- **A mismatch is a `400`** (`BadRequestException`) and **nothing is written,
  audited, or emitted.** The customer is left completely untouched — same status,
  same email, same carts. This is verified by the use-case spec: a wrong
  `confirmEmail` leaves the writer, the audit publisher, and the event publisher all
  uncalled.

## Interaction with the idempotency short-circuit

The guard is **skipped** when the customer is already `status = 'deleted'`. That
branch short-circuits first (returning the existing tombstone), and it does so on
purpose: a tombstoned customer has had its email nulled, so there is no current
email to confirm against — requiring one would make a repeated erase impossible and
turn the naturally-idempotent endpoint into a one-shot. Skipping the guard on an
already-erased customer keeps the erase safe to retry (a client timeout, a
double-submit) while still guarding every erase that actually destroys data — the
guard protects the *first, destructive* call, and the idempotent replay needs no
protection because it destroys nothing.

## Why an email and not, say, a checkbox

A generic "are you sure?" confirmation guards against *clicking* by accident but not
against *targeting* the wrong record — a reflexive confirm still erases whatever row
was selected. Requiring the customer's own email forces the operator to look up and
reproduce a fact specific to the intended target, which catches the far more
dangerous mistake: erasing the wrong customer. It is the same reasoning that makes
destructive CLI and cloud-console actions ask you to type the resource's name rather
than just confirm.

## Related decisions

- [ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md) — the
  consent-and-erasure capability, including the tombstone erase this guard fronts.
- [02-erase-customer-q6.md](02-erase-customer-q6.md) — the full erase sequence and
  the tombstone semantics.
- [ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md) — the
  `customer:erase` admin permission that gates the endpoint the guard lives on.
