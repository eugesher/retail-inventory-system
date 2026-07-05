# The consent, erasure, and marketing HTTP surface (and the request libraries)

This document is the operator's-eye view of the consent-and-erasure capability: the
gateway HTTP endpoints it added, how each is authorized, and the two parallel
request libraries that exercise them end-to-end. The domain and persistence detail
lives in the sibling docs — this one is about the wire surface and how to drive it.

The governing decision is
[ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md). The pieces this
surface fronts are documented in
[01-consent-record-aggregate.md](01-consent-record-aggregate.md) (the record and
its persistence), [02-erase-customer-q6.md](02-erase-customer-q6.md) (the tombstone
erase), and [03-consent-event-and-cache.md](03-consent-event-and-cache.md) (the
notification consent-gate the marketing send flows through).

## The customer-side API — self-service consent

A customer manages their own channel-consent preferences at two routes on the
gateway `auth` module
(`apps/api-gateway/src/modules/auth/presentation/customer-consent.controller.ts`):

| Method | Path | Auth |
| --- | --- | --- |
| `GET` | `/api/auth/customer/me/consent` | Bearer customer, **no permission code** |
| `PUT` | `/api/auth/customer/me/consent` | Bearer customer, **no permission code** |

**Why no permission code.** Under [ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)
and [ADR-028](../../adr/028-cart-order-payment-and-address-chain.md) a customer JWT
carries an **empty `permissions` claim** — a customer is not an RBAC actor. A
`@RequiresPermission('customer:...')` gate would therefore be unreachable dead code
on a customer-facing route. Instead the controller folds `@CurrentUser().id` into
the query/command, so a customer can only ever read or write **their own** record.
Ownership is inherent in the token, not asserted by a permission. This is the same
reasoning that keeps a permission code a *staff override* over an owner-check rather
than a customer gate.

**The `GET` response** is a `ConsentRecordView`:

```json
{
  "customerId": "…",
  "transactionalEmail": true,
  "marketingEmail": false,
  "marketingSms": false,
  "dataRetentionPolicy": "default-7-years",
  "updatedAt": null
}
```

A customer with **no stored row** resolves to exactly these defaults — an absent
record is never a `404`. The defaults are the privacy-conservative choice:
transactional email is on (order confirmations, shipping notices), both marketing
channels are off until the customer opts in.

**The `PUT` body is a partial upsert-merge.** Every field is optional; the write
overlays only the keys supplied and leaves the rest at their current value:

```json
{ "marketingEmail": true }
```

That single-field body opts the customer into marketing email and touches nothing
else. A successful write stamps `updatedAt` and **emits `customer.consent.updated`**,
which the notification service consumes to refresh its consent cache — so the very
next marketing send weighs the new state (see the marketing-send seam below).

## The admin-side API — read-any-consent and tombstone-erase

Staff operate on **any** customer through the thin `customer-admin` shell
(`apps/api-gateway/src/modules/customer-admin/presentation/customer-admin.controller.ts`),
which has no `domain/` of its own — it injects use cases the `auth` module exports
(the `iam` precedent). Both routes are staff-gated with an explicit
`@RequiresPermission(...)`:

| Method | Path | Permission |
| --- | --- | --- |
| `GET` | `/api/admin/customers/:id/consent` | `customer:read-consent` |
| `POST` | `/api/admin/customers/:id/erase` | `customer:erase` |

**Read-any-consent** reuses the same owner-or-staff `ReadConsentUseCase` as the
customer route, but with the staff override (`isStaff: true`), so an admin reads any
customer's record. Absent row → defaults, never a `404`. A staff token missing the
code gets a `403`; a customer token gets a `403` too (its empty `permissions` claim
can never satisfy a code gate).

**Tombstone-erase** is the irreversible one. Its body carries a `confirmEmail`
field, and the request returns the tombstone marker:

```
POST /api/admin/customers/{id}/erase
{ "confirmEmail": "buyer@example.com" }
→ 200 { "status": "deleted", "erasedAt": "2026-07-06T12:00:00.000Z" }
```

- The **`confirmEmail` guard** — `confirmEmail` must equal the customer's *current*
  email (case-insensitively). A mismatch is a `400` and **nothing is written,
  audited, or emitted**; the path id selects which customer, the email proves the
  operator knows which customer that is, and the two must agree. The full rationale
  is [05-confirm-email-guard.md](05-confirm-email-guard.md).
- The erase **nulls PII** across `customer`, its `address` rows, and abandons active
  `cart`s in one transaction; sets `status='deleted'` + `deleted_at`; nulls the
  refresh-token hash (so any live session's `/auth/refresh` now `401`s). It emits
  `customer.erased`, which carries **no PII** — ids and `erasedAt` only.
- It is **idempotent**: re-erasing an already-`deleted` customer is a `200` no-op
  that skips the confirm guard (a tombstone has no email to confirm against). The
  sequence is [02-erase-customer-q6.md](02-erase-customer-q6.md).

## The marketing-send seam

Marketing is a staff-triggered dispatch on the gateway notifications controller
(`apps/api-gateway/src/modules/notifications/presentation/notifications.controller.ts`),
kept there rather than on `customer-admin` because the route fronts the notification
service:

| Method | Path | Permission |
| --- | --- | --- |
| `POST` | `/api/notifications/marketing/send` | `notifications:write` |

```json
{
  "customerId": "…",
  "customerEmail": "buyer@example.com",
  "eventType": "marketing.email.promo",
  "campaignId": "summer-sale-2026",
  "context": { "customerName": "Casey", "promoCode": "SAVE20" }
}
```

- `customerEmail` is a **documented operator input**, not a server-side lookup of the
  `auth` module's `customer` table — reading that table from the notifications
  gateway module would cross a module boundary for no functional gain (ADR-037).
- `eventType` defaults to `marketing.email.promo` (a **non-transactional** routing
  key) and `campaignId` defaults to a fresh UUID per request, so repeated sends to
  one customer are distinct delivery rows. An operator-supplied `campaignId` is
  honored.
- **Consent-gated.** The endpoint never inspects consent itself: it dispatches the
  RPC, and the notification service's consent-gate decides the outcome against the
  customer's `marketingEmail` flag. A customer who has *not* opted in yields a
  terminal `skipped-no-consent` delivery row (the gate records what *would* have been
  sent but never calls the notifier); an opted-in customer yields a `sent` row. The
  gate mechanics are [03-consent-event-and-cache.md](03-consent-event-and-cache.md).
- The RPC is **request-response**, so the `200` response body *is* the resulting
  `NotificationDeliveryView` (empty only when no marketing template resolves). The
  row is also queryable via `GET /api/notifications/deliveries?eventReferenceType=marketing&eventReferenceId=<campaignId>`.

## The request-library files

Every route above is described in **two parallel request libraries**, kept in
lockstep. Both cover the identical flows — they differ only in format and in how a
request chains off an earlier response.

### Kulala — `http/kulala/*.http`

Editor-run `.http` files (the [kulala.nvim](https://github.com/mistweaverco/kulala.nvim)
format; equally readable in any REST-client that understands the syntax). Each file
opens with `@baseUrl = {{ENV_BASE_URL}}` (resolved from
`http/kulala/http-client.env.json` → `http://localhost:3000/api`), separates
requests with `###`, names each with `# @name <id>`, and cites its controller path
in a header comment. Chaining is **declarative**: a later block interpolates an
earlier response inline, e.g. `{{login.response.body.$.accessToken}}`, captured into
an `@accessToken` variable.

| File | Routes | Login flow |
| --- | --- | --- |
| `consent.http` | `GET`/`PUT /auth/customer/me/consent` | seeded **customer** (`customer@example.com` / `customer1234`) |
| `customer-admin.http` | `GET /admin/customers/:id/consent`, `POST /admin/customers/:id/erase` | seeded **admin** (`admin@example.com` / `admin1234`) |
| `notifications.http` (marketing block) | `POST /notifications/marketing/send` | seeded **admin** |

`customer-admin.http` registers a **throwaway** customer inline and erases *that*
one, so running the file top-to-bottom never destroys the seeded fixture and repeats
cleanly (the erase frees the throwaway email for re-registration). Run: open the
file and send blocks top-to-bottom (the `login` block first captures `@accessToken`).

### Posting — the `http/posting/` collection

A [Posting](https://posting.sh) port of the same flows, one subcollection folder per
Kulala file and one `<kebab-name>.posting.yaml` per request. The base URL comes from
`http/posting/dev.env` (`$ENV_BASE_URL`). Posting has **no declarative chaining** —
it substitutes variables with a strict `string.Template`, so a `$var` must already
exist in the session or the request fails loudly with a `SubstitutionError`. Chaining
is therefore **imperative**: a producer's `on_response` script (in a per-subcollection
`scripts.py`) calls `posting.set_variable("accessToken", …)`, and consumers read
`$accessToken`. The Kulala block comment carries over into each request's
`description:` field.

| Subcollection | Requests | Capture script |
| --- | --- | --- |
| `consent/` | `login`, `get-my-consent`, `set-my-consent-marketing-on`, `set-my-consent-marketing-off`, `set-retention-policy` | `consent/scripts.py:capture_login` → `$accessToken` |
| `customer-admin/` | `login`, `admin-get-consent`, `register-throwaway`, `admin-erase-customer-confirm-mismatch`, `admin-erase-customer` | `capture_login` → `$accessToken`, `capture_register_throwaway` → `$throwawayCustomerId` |
| `notifications/` (`send-marketing`) | `send-marketing` (added) | reuses the existing `notifications/scripts.py:capture_login` → `$accessToken` |

The seeded customer id is a literal UUID inlined into `admin-get-consent`'s URL (a
safe read); the erase requests read the captured `$throwawayCustomerId`, so — as in
the Kulala file — they target a disposable customer, never the seed. Run:

```bash
posting --collection http/posting --env http/posting/dev.env
```

Launch at the collection **root** so the script paths (`consent/scripts.py:…`)
resolve. Run each subcollection **top-to-bottom** — the login/producer requests
first, then the consumers that read their captured variables.

### Prerequisites (both libraries)

Bring the stack up, migrate, seed, and start the gateway:

```bash
docker compose up -d
yarn migration:run
yarn test:seed
yarn start:dev
```

The seed provides the acceptance customer (`customer@example.com`, id
`00000000-0000-4000-a000-000000000002`) with a `consent_record` at the defaults, and
the `marketing.email.promo` template a `sent` marketing delivery renders against.

## Related documents

- [ADR-037](../../adr/037-consent-record-and-tombstone-erasure.md) — the
  consent-and-erasure capability (record, tombstone erase, consent-gate, no-PII
  events).
- [01-consent-record-aggregate.md](01-consent-record-aggregate.md) — the
  `ConsentRecord` and its persistence.
- [02-erase-customer-q6.md](02-erase-customer-q6.md) — the tombstone-erase sequence.
- [03-consent-event-and-cache.md](03-consent-event-and-cache.md) — the notification
  consent-gate the marketing send flows through.
- [05-confirm-email-guard.md](05-confirm-email-guard.md) — the erase's `confirmEmail`
  guard.
