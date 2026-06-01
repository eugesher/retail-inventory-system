---
id: epic-13
title: Hardening — ConsentRecord + tombstone-erase Customer (Q6) + session revoke on erase
source_stages: [hardening]
depends_on: [epic-01, epic-05]
microservices: [api-gateway]
task_subfolder: tmp/tasks/epic-13-consent-and-erasure/
docs_subfolder: docs/implementation/13-consent-and-erasure/
---

# Epic 13 — Hardening — ConsentRecord + tombstone-erase Customer (Q6) + session revoke on erase

## Goal

Add the report's Stage-3 Customer-side hardening: `ConsentRecord` (transactional / marketing-email / marketing-sms / data-retention consent timestamps) and the tombstone-erase path for `Erase Customer` (Q6 — null PII, preserve `id`, status flips to `deleted`). Wire the Notification microservice (from `epic-10`) to honour `ConsentRecord` on every dispatch — a notification whose channel is unconsented is short-circuited before the NOTIFIER call (a `NotificationDelivery` row is still persisted with status `skipped-no-consent`). On Erase, revoke active sessions (clear refresh-token hash from the StaffUser/Customer row), null all PII columns on `customer` + `address` rows owned by the customer, and emit `CustomerErased` for downstream consumers.

## In-Scope Entities and Operations

- **ConsentRecord**: `customerId` (PK, FK to `customer.id` — 1:1), `transactionalEmail` (BOOL — default true; required for order-confirmation-style mail), `marketingEmail` (BOOL default false), `marketingSms` (BOOL default false), `dataRetentionPolicy` (VARCHAR(32) — e.g. `default-7-years`), `updatedAt`. Strictly 1:1 with Customer.
- **Operations:**
  - **Record Consent** (Customer self-service) — upsert into `consent_record`; emits `CustomerConsentUpdated`.
  - **Read Consent** (Customer; bearer) — own consent only; admins with `customer:read-consent` can read any.
  - **Erase Customer** (User; `customer:erase` — admins only, on regulatory request) — outcome per Q6:
    1. Null PII columns on `customer` (`email`, `phone`, `firstName`, `lastName`, `passwordHash`, `emailVerifiedAt`).
    2. Null PII columns on every `address` row where `owner_type='customer' AND owner_id=<customerId>`.
    3. Set `customer.status='deleted'`, `customer.deletedAt=now`.
    4. Clear `customer.refreshTokenHash` (revokes any active sessions).
    5. Snapshot Addresses on Orders are NOT touched (they are immutable; per the report's cross-cutting §4, Order Addresses are snapshot copies, not references).
    6. Emit `CustomerErased` event.
  - **Notification dispatch consent-gating** (System; in notification-microservice) — before persisting `NotificationDelivery`, check `ConsentRecord` for the recipient's channel; if unconsented, persist with status `skipped-no-consent` and SHORT-CIRCUIT the NOTIFIER call. **Transactional emails (channel=email, eventType in the seeded transactional set) bypass the marketing-consent check** and are gated only by `transactionalEmail=true` (which defaults true).

## Non-Goals

- **GDPR Data Subject Access Request (DSAR) / portability JSON export** — out of scope. The report's cross-cutting §5 mentions tombstone-erase but not full DSAR. Future hardening item.
- **Right-to-rectification UI flows** — out of scope. Customers can already update profile via `epic-01`'s endpoint.
- **Consent versioning / consent-text-on-record** — out of scope. The columns are timestamps + booleans only; the legal text is presumed managed elsewhere.
- **Per-locale consent text** — out of scope.
- **Cookie consent / web-side tracking consent** — out of scope (no web frontend in this project).
- **Tombstone on StaffUser** — out of scope. Q6 specifically targets Customer PII. StaffUser uses the existing `status='suspended'` + `deletedAt` (soft-delete) shipped in `epic-01`.

## Architectural Decisions Honored

- **Open Question Q6** — tombstone (null PII; preserve id). Hard-deleting the Customer row orphans Orders, which is unacceptable for tax, dispute, and accounting reasons. The Customer row remains as `{ id, status:'deleted', deletedAt }` and all PII columns are nulled.
- **Open Question Q7** — every order produces a Customer row, including guest. Tombstone applies to all status types (guest customers can also request erase; an erase on a guest just nulls their PII and flips status to `deleted`).
- **Open Question Q1** — Cart references Customer. Erased customers' Cart rows are also nulled (`cart.customer_id = null` or the cart is moved to `status='abandoned'` — choose abandoned for simpler invariants).
- **Cross-Cutting "Soft delete vs hard delete":** ConsentRecord is hard-deletable after retention window (per the report's §5 "_hard delete... ConsentRecord can be hard-deleted after retention window_"). Customer PII columns are nulled; the Customer row itself is preserved. Orders, OrderLines, Payments, Refunds, Addresses-on-Orders all retain their immutable post-purchase state.
- **Cross-Cutting "Event emission":** `CustomerErased` is the canonical event (the report's §2 lists `CustomerErased`). Emitted to `customer.erased` routing key on the `ris.events` topic exchange from `epic-11`; consumed by event-store (for the audit log) and by notification (to short-circuit any in-flight `NotificationDelivery`-row creations targeting this customer).
- **Cross-Cutting "Auditability":** Erase is the highest-sensitivity admin action in the system. The `AUDIT_LOG_PUBLISHER` invocation includes the actor StaffUser, the IP address, the customerId, the timestamp, and a non-PII snapshot of "before" (just the customer's `id` + `status`). After-snapshot is `{ status: 'deleted' }`. The PII itself is NEVER captured into the audit log (would defeat the erase).
- **ADR-010** (JWT + RBAC): new permission code `customer:erase` (admins only). `customer:read-consent` for admin oversight. `customer:own-consent:write` for the customer self-service path.
- **ADR-019** (TypeORM + MySQL): new `consent_record` table.

## Persistence Changes

**Added (in api-gateway):**

- `consent_record` table: `customer_id` (FK PK), `transactional_email` (BOOL default true), `marketing_email` (BOOL default false), `marketing_sms` (BOOL default false), `data_retention_policy` (VARCHAR(32) default `'default-7-years'`), `updated_at` (TIMESTAMP).
- `customer.deleted_at` column (TIMESTAMP nullable) added if not already present — the `epic-01` schema added `customer.status` but did not necessarily add `deleted_at`; this epic ensures it exists.

**Modified:**

- `customer.email`/`phone`/`first_name`/`last_name`/`password_hash` — already nullable from `epic-01`'s shape (the schema must allow nulling for the tombstone path). If any are non-null today, alter them nullable in a migration.
- `address.recipient_name`/`line1`/`line2`/`city`/`region`/`postal_code`/`phone` — for `owner_type='customer'` rows, must be nullable. (For `owner_type='order'` rows, the columns can remain `NOT NULL` since those rows are immutable order-snapshots and are never erased.)

**Indexes & constraints:**

- 1:1 FK on `consent_record.customer_id → customer.id ON DELETE CASCADE` (consent dies with the customer row should the row ever be hard-deleted — but it won't be, per Q6).

## Eventing / Messaging

- **New routing keys:**
  - `customer.consent.updated` — `{ customerId, transactionalEmail, marketingEmail, marketingSms, dataRetentionPolicy, updatedAt, eventVersion: 'v1', correlationId }`.
  - `customer.erased` — `{ customerId, erasedAt, actorStaffUserId, eventVersion: 'v1', correlationId }`. **No PII in the payload.**
- **Consumed in notification-microservice:**
  - `customer.consent.updated` — cached locally (in-memory + Redis with TTL — key `ris:notifications:consent:v1:<customerId>`) so the consent-gate check on dispatch doesn't need to RPC the api-gateway per delivery. On startup, the notification microservice doesn't preload — it lazy-loads on first dispatch for each customer (cache-aside per ADR-002/006/016).
  - `customer.erased` — clears the cached consent + skips any queued notifications for that customer.

## API Surface

**New HTTP endpoints in `api-gateway`** (extending `modules/auth/` for the customer-side, plus `modules/customer-admin/` for the admin-side):

| Method | Path | Body / params | Auth | Notes |
|---|---|---|---|---|
| `GET` | `/api/auth/customer/me/consent` | — | bearer (customer) | Read own ConsentRecord. |
| `PUT` | `/api/auth/customer/me/consent` | `{ transactionalEmail?, marketingEmail?, marketingSms?, dataRetentionPolicy? }` | bearer (customer) + `customer:own-consent:write` | Upsert; emits `customer.consent.updated`. |
| `GET` | `/api/admin/customers/:id/consent` | — | bearer + `customer:read-consent` | Admin oversight. |
| `POST` | `/api/admin/customers/:id/erase` | `{ confirmEmail }` (the operator types the customer's current email as a "are you sure" guard) | bearer + `customer:erase` | Tombstone path. Returns `{ status: 'deleted', erasedAt }`. |

**Kulala HTTP files** (under `http/`):

- **`http/consent.http`** — NEW; customer-side GET/PUT consent.
- **`http/customer-admin.http`** — NEW; admin-side consent read + erase.

## Test Strategy

**Unit tests:**

- `apps/api-gateway/src/modules/auth/domain/spec/consent-record.model.spec.ts` — required-fields, default-true on `transactionalEmail`.
- `apps/api-gateway/src/modules/auth/application/use-cases/spec/record-consent.use-case.spec.ts`.
- `apps/api-gateway/src/modules/auth/application/use-cases/spec/erase-customer.use-case.spec.ts` — the full tombstone sequence; addresses where `owner_type='order'` are NOT touched; refresh-token hash cleared; `customer.email` is null after; `customer.status='deleted'`; event emitted with no PII in payload; AuditLogEntry emitted via the publisher port.
- Updated `apps/notification-microservice/src/modules/notifications/application/use-cases/spec/render-and-dispatch.use-case.spec.ts` — consent-gate scenarios: marketing email without consent → `skipped-no-consent`; transactional email always sent.

**E2E tests:**

- `test/consent-roundtrip.e2e-spec.ts`: customer reads default consent → sets marketingEmail=true → reads back; admin GET sees the same; subsequent marketing-template send produces a `sent` `NotificationDelivery`. Setting marketingEmail=false reverses it.
- `test/erase-customer-tombstone.e2e-spec.ts`: admin erases a customer (typing the right confirmEmail); GET customer/:id (admin) shows `{ id, status: 'deleted', email: null, ... }`; GET orders/:id still resolves (Order row intact, addressee snapshot intact); customer's refresh-token rejected → `401`.
- `test/notification-consent-gating.e2e-spec.ts`: send a marketing event for a customer with `marketingEmail=false` → `NotificationDelivery` persisted with `status='skipped-no-consent'`; NOTIFIER never called.
- `test/erase-customer-confirm-guard.e2e-spec.ts`: wrong `confirmEmail` → `400`.

**Concurrency tests:** N/A (Erase is an admin action; concurrent erase is degenerate — last-writer-wins is acceptable since Erase is idempotent on a deleted customer).

**Seed data required:**

- Seeded customer has a `consent_record` row with defaults (transactional=true, marketing=false).
- New permission codes: `customer:own-consent:write`, `customer:read-consent`, `customer:erase`.

## Documentation Deliverables

**Per-task markdown files** under `docs/implementation/13-consent-and-erasure/`:

- `01-consent-record-aggregate.md` — the four fields; default-true transactional; the bypass rule for transactional channels.
- `02-erase-customer-q6.md` — restate Q6; the per-column nulling list; what is NOT erased (Order snapshots); session revocation.
- `03-consent-event-and-cache.md` — how the notification microservice keeps consent fresh without an RPC per dispatch.
- `04-customer-erased-event-and-pii.md` — explicit non-leak: no PII in the event payload; no PII in the audit log row.
- `05-confirm-email-guard.md` — the operator UX guard.
- `06-consent-and-erase-api-and-http-files.md`.

**`README.md` updates required:**

- New **Privacy & consent** section under **API** describing the customer-side endpoints and the tombstone-erase semantics.
- **Authentication → Roles** updated for the three new permission codes.

**`CLAUDE.md` updates required:**

- Add `consent_record` to the **modules/auth** file-listing snippet.
- Add a **Privacy / GDPR conventions** bullet under Operational notes: tombstone-only; PII never in event payloads or audit log rows; Order snapshots are immutable.

**Exclusions Register documents owned by this epic:** None (all under `epic-15`).

## Tasks (decomposition hint)

1. **Add `consent_record` table + entity + repository.** Migration. Migration also ensures `customer` + `address` nullability.
2. **Implement Record Consent + Read Consent use cases + endpoints.**
3. **Implement Erase Customer use case + endpoint.** Full tombstone sequence; confirm-email guard.
4. **Add routing keys + publish `customer.consent.updated` + `customer.erased`.**
5. **Add the consent cache in the notification-microservice + the consent-gate to Render & Dispatch.**
6. **Author the four e2e tests.**
7. **Author `http/consent.http` + `http/customer-admin.http`.**
8. **Seed + docs pass.**

## Carryover Between Tasks

| Task | Entry state assumed | Carryover artifacts produced (never under `tmp/`) |
|---|---|---|
| 1 | `epic-01`, `epic-05`, `epic-10`, `epic-11` complete. | Migration + entities + repository; `01-…md`. |
| 2 | Task 1 complete. | Two use cases + specs + customer-side controller; `01-…md` complete. |
| 3 | Tasks 1–2 complete. | Erase use case + spec + admin controller; `02-…md`, `05-…md`. |
| 4 | Tasks 1–3 complete. | New routing keys; updated publishers; `04-…md`. |
| 5 | Tasks 1–4 complete. | Updated Render & Dispatch use case + spec; consent cache (`ICachePort.singleFlight`-based) in notification-microservice; `03-…md`. |
| 6 | Tasks 1–5 complete. | Four e2e files. |
| 7 | Task 3 + Task 2 complete. | Two Kulala files; `06-…md`. |
| 8 | All prior tasks complete. | Updated seed, README, CLAUDE.md, fixtures. |

## Exit Criteria

- [ ] `yarn lint` passes.
- [ ] `yarn test:unit` passes; new + updated specs green.
- [ ] `yarn test:e2e` passes; four new e2e files green.
- [ ] Admin Erase on the seeded customer: row preserved with `id` + `status='deleted'`; `email`/`phone`/`firstName`/`lastName` null; address rows owned by the customer nulled; orders unaffected; refresh-token rejected.
- [ ] Marketing email to an unconsented customer produces a `NotificationDelivery` row with `status='skipped-no-consent'`; NOTIFIER not called.
- [ ] Transactional email to a customer with `transactionalEmail=true` succeeds regardless of marketing consent.
- [ ] `customer.erased` event payload contains NO PII (only the customerId + actor + timestamp); the audit log row matches.
- [ ] Every request in `http/consent.http` + `http/customer-admin.http` executes end-to-end.
- [ ] Per-task docs present under `docs/implementation/13-consent-and-erasure/`.
- [ ] `README.md` + `CLAUDE.md` updated.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`.

## Self-Containment Notice

> Tasks generated from this epic must produce outputs that contain no references to anything under `tmp/`. The orchestration scratch space is not part of the final deliverable.
