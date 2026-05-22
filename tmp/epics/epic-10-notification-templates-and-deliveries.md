---
id: epic-10
title: Notifications — NotificationTemplate registry + NotificationDelivery persistence + render-and-dispatch
source_stages: [production-core]
depends_on: [epic-05]
microservices: [api-gateway, notification-microservice]
task_subfolder: tmp/tasks/epic-10-notification-templates-and-deliveries/
docs_subfolder: docs/implementation/epic-10-notification-templates-and-deliveries/
---

# Epic 10 — Notifications — NotificationTemplate registry + NotificationDelivery persistence + render-and-dispatch

## Goal

Promote the notification microservice from "fire log lines from inline strings" to a real notifications surface. Add `NotificationTemplate` (versioned, per-event-type, per-channel) and `NotificationDelivery` (queued/sent/delivered/failed/bounced, with retry tracking). Implement Render & Dispatch (System) and Record Delivery Outcome (System) and Author Template (User). Re-wire every consumer added by `epic-05`/`epic-07`/`epic-08`/`epic-09` so that on receipt of a domain event, the service (a) loads the matching template for the consumer's channel, (b) renders, (c) persists a `NotificationDelivery` row, (d) hands off to the channel adapter via the `NOTIFIER` port. After this epic, the customer-facing notification surface is testable, queryable, and one rebind away from real email/SMS.

## In-Scope Entities and Operations

- **NotificationTemplate**: `id`, `eventType` (e.g. `retail.order.placed`), `channel` (`email` | `sms` | `push` | `webhook`), `locale` (e.g. `en-US`), `subject` (nullable for sms/push), `body` (handlebars/mustache-style — choose one in task 1; recommend `handlebars` for minimal dependency), `version` (INT — bumps on edit; old versions retained), `active` (BOOL), timestamps. Composite uniqueness `(eventType, channel, locale, version)`.
- **NotificationDelivery**: `id`, `templateId` (FK), `recipientCustomerId` (nullable for system-only notifications), `recipientAddress` (email/phone/url), `channel`, `eventReferenceType` (e.g. `order` | `return-request` | `stock-low`), `eventReferenceId`, `status` (`queued` | `sent` | `delivered` | `failed` | `bounced`), `attemptCount` (INT default 0), `lastAttemptAt` (TIMESTAMP nullable), `failureReason` (TEXT nullable), `renderedSubject` (TEXT nullable), `renderedBody` (TEXT), `correlationId`, timestamps.
- **Operations:**
  - **Author Template** (User; `notifications:write`) — create/edit a template; edits create a new `version` (old rows retained for audit / rollback).
  - **Render & Dispatch Notification** (System) — triggered by event consumers; loads the latest `active` template for `(eventType, channel, locale)`; renders against the event payload + customer context; persists `NotificationDelivery` row in `queued`; calls `NOTIFIER.deliver(...)`; updates row to `sent` on success or `failed` with `failureReason` + increments `attemptCount`.
  - **Record Delivery Outcome** (System) — provider webhook handler (sketched; real ESP integration is OOS) flips `sent` → `delivered`/`bounced`.
  - **Retry Failed Delivery** (System) — background worker (sketched as a job in this epic; full implementation deferred to a future hardening epic) re-attempts `failed` deliveries with backoff up to `MAX_DELIVERY_ATTEMPTS` (env, default 3).
- **Templates to seed (one per event-type / channel / locale = `en-US`):**
  - `retail.order.placed` → email subject "Order #{{orderNumber}} confirmed", body with line items + grand total.
  - `retail.fulfillment.shipped` → email subject "Order #{{orderNumber}} has shipped", body with carrier + tracking number.
  - `retail.fulfillment.delivered` → email subject "Your order arrived".
  - `retail.order.cancelled` → email.
  - `retail.return.requested` / `retail.return.authorized` / `retail.return.received` / `retail.return.inspected` → email.
  - `retail.refund.issued` → email.
  - `inventory.stock.low` → email to ops mailbox (`OPS_NOTIFICATIONS_EMAIL` env var).

## Non-Goals

- **Marketing campaigns, segmentation, A/B testing, abandoned-cart automation, in-app inbox/feed, customer messaging/chat, push device-token registration as first-class entity, webhook subscription management UI, scheduled batch newsletters** — Exclusions Register (`epic-15`).
- **Multi-channel orchestration fallback** (push→sms→email) — out of scope; this epic dispatches one delivery per consumer per event.
- **Real ESP integration** (SendGrid / SES / Twilio) — the `email.notifier.adapter.ts` and `webhook.notifier.adapter.ts` scaffolds added by `ADR-011` remain TODO; `log.notifier.adapter.ts` is the working default.
- **Locale-aware template selection from customer preference** — locale is hardcoded to `en-US` in this epic; the column ships so a future epic can wire customer-preference resolution.
- **Per-customer template overrides** — out of scope.

## Architectural Decisions Honored

- **Cross-Cutting "Soft delete vs hard delete":** NotificationTemplate is soft-delete (`active=false`, never `deletedAt`) — old versions retained for audit; `NotificationDelivery` is **live ephemeral** (purged after retention window — purge job is a future hardening item; `RETENTION_DELIVERY_DAYS=90` env var ships).
- **Cross-Cutting "Auditability":** notification template authoring is in the "NOT required at same fidelity" set; this epic does NOT invoke `AUDIT_LOG_PUBLISHER` on template edits. Delivery rows themselves are the audit trail for outgoing notifications.
- **ADR-011** (NotifierPort and notification-microservice as the per-module template): the existing `NOTIFIER` port + `LogNotifierAdapter` default + email/webhook scaffolds are preserved. This epic threads `NotificationDelivery` persistence in front of the `NOTIFIER` call, but the port surface remains "one method: `deliver(payload)`". Adapters now receive a `renderedBody`/`renderedSubject` field in the payload that they did not before.
- **ADR-008** (dotted routing keys): notification subscribes to existing keys; no new producer keys here. Optional new producer key `notifications.delivery.failed` (emitted on `failed` status) — used by a future retry scheduler.
- **ADR-016 + ADR-022** (cache keys): if template lookup becomes hot, key convention `ris:notifications:template:v1:<eventType>:<channel>:<locale>`. Builder added; not yet consumed.
- **ADR-019** (TypeORM + MySQL): the notification microservice gains a database for the first time; `DatabaseModule.forRoot(...)` wired into `app.module.ts`; new migration adds tables.
- **ADR-010** (RBAC): template author endpoints behind `notifications:write` (seeded into `admin`).

## Persistence Changes

**Added (in notification-microservice — first DB tables for this service):**

- `notification_template` table: `id` (BIGINT PK), `event_type` (VARCHAR(64)), `channel` (ENUM), `locale` (VARCHAR(10)), `subject` (TEXT nullable), `body` (TEXT NOT NULL), `version` (INT), `active` (BOOL default true), timestamps. Unique `(event_type, channel, locale, version)`. Index on `(event_type, channel, locale, active)` for the "find latest active" query.
- `notification_delivery` table: `id` (BIGINT PK), `template_id` (FK), `recipient_customer_id` (VARCHAR(64) nullable), `recipient_address` (VARCHAR(255)), `channel` (ENUM), `event_reference_type` (VARCHAR(32)), `event_reference_id` (VARCHAR(64)), `status` (ENUM), `attempt_count` (INT default 0), `last_attempt_at` (TIMESTAMP nullable), `failure_reason` (TEXT nullable), `rendered_subject` (TEXT nullable), `rendered_body` (TEXT), `correlation_id` (VARCHAR(64)), timestamps. Index on `(status, last_attempt_at)` for the retry sweeper; index on `(event_reference_type, event_reference_id)` for audit lookups; index on `(recipient_customer_id, created_at DESC)`.

**Indexes & constraints:**

- See above.
- FK `notification_delivery.template_id → notification_template.id ON DELETE RESTRICT` (delivery rows must outlive template-edit churn).

## Eventing / Messaging

- **Consumed events** (subscriptions added/extended by this epic):
  - `retail.order.placed`, `retail.fulfillment.shipped`, `retail.fulfillment.delivered`, `retail.order.cancelled`, `retail.return.requested`, `retail.return.authorized`, `retail.return.received`, `retail.return.inspected`, `retail.refund.issued`, `inventory.stock.low`.
- **New producer key (optional):** `notifications.delivery.failed` — emitted when `attempt_count >= MAX_DELIVERY_ATTEMPTS`. Payload: `{ deliveryId, eventReferenceType, eventReferenceId, failureReason, eventVersion: 'v1', correlationId }`.
- **No retired keys.**
- **Customer-address resolution:** the notification consumer needs the recipient's email. Two options: (a) cross-service RPC into api-gateway's customer module for each delivery, or (b) include `customerEmail` in the producing event payload. **Choose (b)** — each producer event payload is extended with `customerEmail` (and `customerLocale` for future-locale-resolution). This requires per-producer-event-shape additions in `epic-05`/`epic-08`/`epic-09`. Apply the additions as part of this epic via small, targeted edits to the producer publishers (limit scope to the email field; if locale resolution becomes a thing, add it then).

## API Surface

**New HTTP endpoints in `api-gateway`** (new `modules/notifications/` module — gateway proxy):

| Method | Path | Body / params | Auth | Notes |
|---|---|---|---|---|
| `GET` | `/api/notifications/templates` | query: `?eventType=&channel=&locale=` | bearer + `notifications:write` | List templates. |
| `POST` | `/api/notifications/templates` | `{ eventType, channel, locale, subject?, body }` | bearer + `notifications:write` | Create new version (bumps `version`). |
| `PATCH` | `/api/notifications/templates/:id/active` | `{ active }` | bearer + `notifications:write` | Activate/deactivate a specific version. |
| `GET` | `/api/notifications/deliveries` | query: `?customerId=&eventReferenceType=&eventReferenceId=&status=&page=` | bearer + `notifications:read` | Audit/query of delivery rows. |
| `GET` | `/api/notifications/deliveries/:id` | — | bearer + `notifications:read` | Full delivery row including `renderedBody`. |
| `POST` | `/api/notifications/deliveries/:id/retry` | — | bearer + `notifications:write` | Manual retry for stuck failures. |

**Kulala HTTP files** (under `http/`):

- **`http/notifications.http`** — NEW; covers template author + delivery query + manual retry.

## Test Strategy

**Unit tests:**

- `apps/notification-microservice/src/modules/notifications/domain/spec/notification-template.model.spec.ts` — version bump on edit; channel-specific subject-required rules.
- `apps/notification-microservice/src/modules/notifications/domain/spec/notification-delivery.model.spec.ts` — status transitions; `attempt_count` monotonic.
- `apps/notification-microservice/src/modules/notifications/application/use-cases/spec/author-template.use-case.spec.ts` — duplicate `(eventType, channel, locale, version)` rejected; new edit auto-increments version.
- `apps/notification-microservice/src/modules/notifications/application/use-cases/spec/render-and-dispatch.use-case.spec.ts` — template lookup; render produces expected output for a fixture payload; `NotificationDelivery` row persisted before NOTIFIER call; status flips correctly on success/failure.
- `apps/notification-microservice/src/modules/notifications/application/use-cases/spec/record-delivery-outcome.use-case.spec.ts` — webhook payload → status flip.
- `apps/notification-microservice/src/modules/notifications/application/use-cases/spec/retry-failed-delivery.use-case.spec.ts` — backoff respected; cap respected; emits `notifications.delivery.failed` at the cap.
- Updated `apps/notification-microservice/src/modules/notifications/infrastructure/consumers/spec/*.consumer.spec.ts` for every existing consumer: now persists delivery row before calling NOTIFIER.

**E2E tests:**

- `test/notifications-place-order.e2e-spec.ts`: place an order → assert a `NotificationDelivery` row exists in `sent` for the seeded customer email + template `retail.order.placed`; `renderedBody` includes the orderNumber.
- `test/notifications-ship-fulfillment.e2e-spec.ts`: ship → delivery row with tracking number rendered.
- `test/notifications-low-stock.e2e-spec.ts`: trigger low-stock event → delivery to ops mailbox.
- `test/notifications-template-edit.e2e-spec.ts`: edit a template (creates v2) → next order uses v2's body.
- `test/notifications-retry.e2e-spec.ts`: simulate NOTIFIER failure (a fake adapter that rejects); assert `failed` → retry runs → success on second attempt → final `sent`.

**Concurrency tests:** double-delivery prevention — two consumers receiving the same event must not produce two `sent` rows for the same `(eventReferenceType, eventReferenceId, channel, customerId)`. Idempotent via a unique partial index on `(event_reference_type, event_reference_id, channel, recipient_customer_id)` for non-final statuses.

**Seed data required:**

- One template per event-type listed above, in `en-US`, `active=true`, `version=1`.
- `OPS_NOTIFICATIONS_EMAIL=ops@example.com` in `.env.example`.
- `MAX_DELIVERY_ATTEMPTS=3`, `RETENTION_DELIVERY_DAYS=90` in `.env.example`.

## Documentation Deliverables

**Per-task markdown files** under `docs/implementation/epic-10-notification-templates-and-deliveries/`:

- `01-notification-template-versioning.md` — why `version` is part of the unique key; how rollback works.
- `02-notification-delivery-as-audit-trail.md` — the delivery row is the source of truth for "did we send this?"; retention semantics.
- `03-render-and-dispatch-pipeline.md` — the consumer-callback shape: load template → render → persist row → NOTIFIER → status flip; failure handling.
- `04-customer-email-on-producer-events.md` — the producer-side payload addition; why (b) over (c).
- `05-handlebars-renderer-choice.md` — why handlebars (or mustache) over EJS / JSX-server; security note about user-supplied template content.
- `06-retry-and-failure-events.md` — backoff policy; the `notifications.delivery.failed` event for downstream alerting.
- `07-notifications-api-and-http-file.md`.

**`README.md` updates required:**

- **System diagram**: update the notification microservice box to show the two new tables and the `NotificationDelivery` audit path.
- **API → Notifications** new section.
- New top-level **Notifications** section under **Logging & Observability** describing the template / delivery / retry model and how to inspect delivery rows.

**`CLAUDE.md` updates required:**

- Update the **notification-microservice** section to reflect the new database, the new use cases, and the new persistence-before-notifier order in the consumer pipeline.
- Note: producer events now carry `customerEmail` (and `customerLocale`) — update the payload-shape descriptions for the relevant routing keys.

**Exclusions Register documents owned by this epic:** None (all under `epic-15`).

## Tasks (decomposition hint)

1. **Wire DatabaseModule into notification-microservice** (first time); add migrations for the two new tables.
2. **Add NotificationTemplate + NotificationDelivery entities + persistence + repositories + domain specs.**
3. **Pick + wire a handlebars (or mustache) renderer adapter.**
4. **Implement Render & Dispatch use case** — the consumer-callback skeleton; persist before NOTIFIER call; status transitions.
5. **Implement Author Template + Activate/Deactivate use cases + endpoints.**
6. **Implement Record Delivery Outcome use case** (webhook handler endpoint exists but is a stub for the future ESP integration).
7. **Implement Retry Failed Delivery use case** + a simple cron-style timer (using `@nestjs/schedule`); cap + emit `notifications.delivery.failed`.
8. **Update every existing event consumer** (`order-events.consumer.ts`, `inventory-events.consumer.ts`, plus the new fulfillment + return + refund consumers added inline by `epic-08`/`epic-09`) to use the Render & Dispatch use case instead of inlined log calls.
9. **Add the producer-side `customerEmail` / `customerLocale` payload additions** to every producer event in `epic-05`/`epic-08`/`epic-09`. (Targeted publisher edits; no new use cases.)
10. **Add the api-gateway `modules/notifications/` proxy module** + controllers + DTOs.
11. **Seed templates** (one per event type) + permissions + env vars.
12. **Author `http/notifications.http`.**
13. **Documentation pass.**

## Carryover Between Tasks

| Task | Entry state assumed | Carryover artifacts produced (never under `tmp/`) |
|---|---|---|
| 1 | `epic-05`/`epic-07`/`epic-08`/`epic-09` complete. | Updated `apps/notification-microservice/src/app/app.module.ts` with DatabaseModule; new migrations; `01-…md`. |
| 2 | Task 1 complete. | Entities + mappers + repositories + specs. |
| 3 | Tasks 1–2 complete. | New `TemplateRendererPort` + adapter under `infrastructure/render/`; `05-…md`. |
| 4 | Tasks 1–3 complete. | Render & Dispatch use case + spec; `03-…md`. |
| 5 | Tasks 1–4 complete. | Author Template use case + spec + endpoints; `01-…md` complete. |
| 6 | Tasks 1–5 complete. | Record Delivery Outcome use case + spec + stub webhook handler. |
| 7 | Tasks 1–6 complete. | Retry use case + spec; `@nestjs/schedule` cron registration; new producer routing key; `06-…md`. |
| 8 | Tasks 1–7 complete. | Updated consumer files + specs; `02-…md`. |
| 9 | Task 8 + producer services from epics 05/08/09 exist. | Producer publisher edits across retail-microservice (and inventory if applicable); `04-…md`. |
| 10 | Tasks 1–9 complete. | api-gateway notifications module + controller + DTOs. |
| 11 | Tasks 1–10 complete. | Seed templates SQL + env vars added. |
| 12 | Task 10 complete. | `http/notifications.http`; `07-…md`. |
| 13 | All prior tasks complete. | Updated README + CLAUDE.md; fixtures. |

## Exit Criteria

- [ ] `yarn lint` passes.
- [ ] `yarn test:unit` passes; ≥7 new specs green + every existing consumer spec updated to assert the persist-before-NOTIFIER ordering.
- [ ] `yarn test:e2e` passes; five new e2e files green.
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev` boots clean; `notification_template` + `notification_delivery` tables present and seeded.
- [ ] Placing an order persists exactly one `NotificationDelivery` row in `sent` status with `renderedBody` rendered from the seeded `retail.order.placed` template.
- [ ] Editing a template creates a new `version` row; the next event uses the new version's body.
- [ ] Forcing a NOTIFIER failure increments `attempt_count`; retry succeeds on second attempt.
- [ ] Every request in `http/notifications.http` executes end-to-end.
- [ ] Per-task docs present under `docs/implementation/epic-10-notification-templates-and-deliveries/`.
- [ ] `README.md` System diagram + API section updated; `CLAUDE.md` notification section updated.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`.

## Self-Containment Notice

> Tasks generated from this epic must produce outputs that contain no references to anything under `tmp/`. The orchestration scratch space is not part of the final deliverable.
