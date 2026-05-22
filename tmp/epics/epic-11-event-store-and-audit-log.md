---
id: epic-11
title: Event-store microservice — DomainEvent firehose + AuditLogEntry write paths
source_stages: [production-core]
depends_on: [epic-01, epic-05]
microservices: [api-gateway, retail-microservice, inventory-microservice, notification-microservice, catalog-microservice, event-store-microservice]
task_subfolder: tmp/tasks/epic-11-event-store-and-audit-log/
docs_subfolder: docs/implementation/epic-11-event-store-and-audit-log/
---

# Epic 11 — Event-store microservice — DomainEvent firehose + AuditLogEntry write paths

## Goal

Stand up a new `event-store-microservice` that owns two append-only logs: `DomainEvent` (the canonical persisted log of every business-significant event flying over RabbitMQ) and `AuditLogEntry` (every StaffUser mutation with before/after snapshots, captured at producer-side use cases via the `AUDIT_LOG_PUBLISHER` port introduced as a no-op in `epic-01`). Subscribe the new microservice to a `#.#` firehose on every routing key already produced by `epic-02` through `epic-10`. Replace the no-op `AUDIT_LOG_PUBLISHER` adapter in every producer service with a real RMQ adapter that emits to a new `audit.staff.action` routing key consumed by this microservice. Read-side query endpoints are deferred to `epic-14`; this epic delivers the ingestion paths and the two tables.

## In-Scope Entities and Operations

- **DomainEvent**: `id` (BIGINT PK), `eventType` (e.g. `retail.order.placed`), `aggregateType` (e.g. `order`), `aggregateId` (VARCHAR(64)), `payload` (JSON), `eventVersion` (VARCHAR(8) — e.g. `v1`), `producer` (e.g. `retail-microservice`), `correlationId` (VARCHAR(64) nullable), `occurredAt` (TIMESTAMP — the producer's emit time, taken from the event payload).
- **AuditLogEntry**: `id` (BIGINT PK), `actorId` (VARCHAR(64)), `actorType` (`staff-user` | `system`), `action` (VARCHAR(64), e.g. `order:cancel` / `inventory:adjust`), `entityType` (VARCHAR(32)), `entityId` (VARCHAR(64)), `before` (JSON nullable), `after` (JSON nullable), `occurredAt` (TIMESTAMP), `ipAddress` (VARCHAR(45) nullable — IPv4/6), `correlationId` (VARCHAR(64) nullable).
- **Operations:**
  - **Ingest DomainEvent** (System) — RMQ consumer subscribed to `#.#` on the existing event bus; persists each event as a `DomainEvent` row. **Idempotent on `(producer, eventType, aggregateId, occurredAt, correlationId)`** — duplicate delivery from RabbitMQ retries does not double-insert.
  - **Ingest AuditLogEntry** (System) — RMQ consumer subscribed to `audit.staff.action`; persists each row.
  - **Emit Domain Event** (System; producer-side) — already implemented in earlier epics as `events.publisher.port.ts` adapters. This epic adds NO new emit responsibilities to producers; the `#.#` consumer captures whatever flows naturally.
  - **Emit AuditLogEntry** (System; producer-side) — every producer service's `AUDIT_LOG_PUBLISHER` adapter is swapped from the no-op to a real RMQ adapter that publishes to `audit.staff.action`. Call sites are unchanged (they were correctly placed in earlier epics).
- **Read endpoints:** NONE in this epic. Query endpoints land in `epic-14`.

## Non-Goals

- **Query / read endpoints over DomainEvent and AuditLogEntry** — owned by `epic-14`.
- **Event-sourced state rebuilds** — out of scope (the report's caveats explicitly note replays + rebuilds are not in the universal core).
- **Retention policy / archival to cold storage** — out of scope (the report's "Live ephemeral" classification does not extend to these; DomainEvent + AuditLogEntry are "append-only, never delete" per cross-cutting §5).
- **Outbox pattern on producers** — out of scope. Producers continue to publish in the same transaction they commit; at-least-once delivery is acceptable for these audit-style logs because the `#.#` consumer is idempotent on a stable composite key.
- **Event-versioning migration / payload-shape upgrades** — out of scope. Every event in the system today is `eventVersion='v1'`; multi-version evolution is future work.
- **Cross-service traces correlation in DomainEvent rows** beyond `correlationId` — out of scope (OTel trace + Pino correlation already provide this).

## Architectural Decisions Honored

- **Cross-Cutting "Event emission":** the report's §2 names 18 mandatory events. After `epic-02` through `epic-10`, every one is being emitted. This epic captures them all via `#.#`.
- **Cross-Cutting "Auditability":** every StaffUser action that mutates Role/Permission/role-binding/Order/Price/Refund/StockMovement/etc. must land in AuditLogEntry. The producer-side `AUDIT_LOG_PUBLISHER` call sites were correctly placed by earlier epics; this epic swaps in the real adapter.
- **Cross-Cutting "Soft delete vs hard delete":** DomainEvent and AuditLogEntry are **append-only, never delete**. No UPDATE either.
- **ADR-008** (dotted routing keys): new routing key `audit.staff.action` (and its `v1` payload shape) added to `libs/messaging/routing-keys.constants.ts`. The event-store consumer uses the wildcard `#.#` pattern (every routing key on the topic exchange).
- **ADR-020** (RabbitMQ as inter-service bus): the `#.#` subscription requires the producer events to live on a **topic exchange**. Today producers publish to the default exchange (per the existing `notification_events` pattern). This epic introduces a new topic exchange `ris.events` and registers every existing event-producer adapter to publish to BOTH the default exchange (preserving the existing consumers like notification's queue-bound subscribers) AND the new `ris.events` topic exchange. The event-store binds its consumer queue to `ris.events` with routing-key `#.#`. The `EXCHANGES` constant in `libs/messaging/exchanges.constants.ts` adds `RIS_EVENTS_TOPIC = 'ris.events'`. The reserved `notification` exchange constant is unaffected.
- **ADR-018** (NestJS monorepo apps + libs): the new microservice is added to `nest-cli.json`, `package.json` scripts, `docker-compose.yml`, OTel collector config.
- **ADR-017** (boundaries): the new microservice is added to the eslint boundaries config + fixture suite.
- **ADR-019** (TypeORM + MySQL): the new microservice gets its own database connection (separate logical DB recommended — `ris_eventstore` — so high-volume writes don't pressure the operational DB; same MySQL instance is fine for portfolio scope).
- **ADR-004 / 009 / 012 / 013** (per-module hexagonal): the new microservice has one bounded context, `audit-and-events`, with two sibling modules: `domain-events/` and `audit-log/`. Both follow the canonical per-module template.
- **ADR-010** (RBAC): this epic adds no HTTP endpoints (queries are `epic-14`); the future query permissions (`audit:read`) were already seeded by `epic-01`.

## Persistence Changes

**Added (in event-store-microservice, in logical DB `ris_eventstore`):**

- `domain_event` table: `id` (BIGINT AUTO_INCREMENT PK), `event_type` (VARCHAR(64)), `aggregate_type` (VARCHAR(32)), `aggregate_id` (VARCHAR(64)), `payload` (JSON), `event_version` (VARCHAR(8)), `producer` (VARCHAR(32)), `correlation_id` (VARCHAR(64) nullable), `occurred_at` (TIMESTAMP), `received_at` (TIMESTAMP default CURRENT_TIMESTAMP).
- `audit_log_entry` table: `id` (BIGINT AUTO_INCREMENT PK), `actor_id` (VARCHAR(64)), `actor_type` (ENUM `staff-user` | `system`), `action` (VARCHAR(64)), `entity_type` (VARCHAR(32)), `entity_id` (VARCHAR(64)), `before` (JSON nullable), `after` (JSON nullable), `occurred_at` (TIMESTAMP), `ip_address` (VARCHAR(45) nullable), `correlation_id` (VARCHAR(64) nullable), `received_at` (TIMESTAMP default CURRENT_TIMESTAMP).

**Indexes & constraints:**

- `domain_event`: composite unique on `(producer, event_type, aggregate_id, occurred_at, correlation_id)` for idempotency on retry; index on `(aggregate_type, aggregate_id, occurred_at DESC)` for future query path; index on `(event_type, occurred_at DESC)`; index on `(correlation_id)`.
- `audit_log_entry`: index on `(actor_id, occurred_at DESC)`; index on `(entity_type, entity_id, occurred_at DESC)`; index on `(action, occurred_at DESC)`; index on `(correlation_id)`.
- Append-only enforced at the repository level (no `update`/`delete` methods exposed); the architecture-lint fixture suite asserts the relevant `BaseTypeormRepository` methods are not used.

## Eventing / Messaging

- **New exchange:** `ris.events` (topic), declared by the event-store-microservice on boot (idempotent declare). Every existing producer publisher adapter gains a "dual-publish" path: continues to publish to the existing destination AND publishes to `ris.events` with the routing key as the topic routing key.
- **New routing key:** `audit.staff.action` — `{ actorId, actorType, action, entityType, entityId, before, after, occurredAt, ipAddress, eventVersion: 'v1', correlationId }`. Published to `ris.events` (and consumed only by the event-store).
- **New queue:** `event_store_firehose_queue` bound to `ris.events` with routing-key `#.#` (every event); processed by the DomainEvent ingestion consumer.
- **New queue:** `event_store_audit_queue` bound to `ris.events` with routing-key `audit.staff.action`; processed by the AuditLogEntry ingestion consumer.
- **Real `AUDIT_LOG_PUBLISHER` adapter** in every producer service (api-gateway, retail, inventory, catalog, notification): RMQ adapter that publishes to `audit.staff.action` on `ris.events`. The no-op adapter from `epic-01` is replaced by `useExisting`/`useClass` rebinds in each service's relevant module.

## API Surface

- **No HTTP endpoints in this epic.** All query endpoints (HTTP for both audit log and domain event) land in `epic-14`.
- **No new Kulala files** in this epic. (`epic-14` adds `http/audit-and-events.http`.)

## Test Strategy

**Unit tests:**

- `apps/event-store-microservice/src/modules/domain-events/domain/spec/domain-event.model.spec.ts` — read-only value object semantics.
- `apps/event-store-microservice/src/modules/audit-log/domain/spec/audit-log-entry.model.spec.ts` — same.
- `apps/event-store-microservice/src/modules/domain-events/application/use-cases/spec/ingest-domain-event.use-case.spec.ts` — duplicate-key idempotency; missing-field rejection (logs `warn`, drops); JSON-parse failure handling.
- `apps/event-store-microservice/src/modules/audit-log/application/use-cases/spec/ingest-audit-log.use-case.spec.ts` — same idempotency + validation.
- Updated `apps/api-gateway/src/modules/auth/application/use-cases/spec/*.spec.ts`, retail/inventory/catalog/notification adapter specs — the swapped real adapter is exercised via test doubles; existing call sites remain correct.

**E2E tests:**

- `test/event-store-firehose.e2e-spec.ts`: spin all services + event-store, perform a Place Order, assert that the event-store-microservice's `domain_event` table contains rows for `retail.order.placed`, `retail.payment.authorized`, `inventory.stock.reserved` (from `epic-07` if it ran first), etc. Verify ordering by `occurredAt`, verify `correlationId` matches across rows.
- `test/event-store-audit-log.e2e-spec.ts`: admin performs an `Assign Role` (or any other audited staff action), assert that the `audit_log_entry` table contains a row with the expected `actorId`, `action='iam:assign'`, before/after snapshot.
- `test/event-store-idempotency.e2e-spec.ts`: manually republish the same event payload twice via a test producer, assert exactly one `domain_event` row exists.

**Concurrency tests:** N/A directly — the consumer is single-process per queue. Add a fan-out test that publishes 100 events concurrently and asserts all 100 land (and that no rows are lost under RabbitMQ retry/redelivery).

**Seed data required:** none for this epic (audit/event-store starts empty and fills from live producer events).

## Documentation Deliverables

**Per-task markdown files** under `docs/implementation/epic-11-event-store-and-audit-log/`:

- `01-new-event-store-microservice-scaffold.md` — the third new microservice; topology + DB choice.
- `02-topic-exchange-ris-events-and-dual-publish.md` — why a new topic exchange; why dual-publish on producers instead of re-binding existing consumers.
- `03-domainevent-ingestion-and-idempotency.md` — the composite-unique idempotency key; what happens on duplicate; the firehose consumer.
- `04-auditlog-ingestion-and-publisher-swap.md` — the `AUDIT_LOG_PUBLISHER` rebind across every service; before/after snapshot conventions.
- `05-no-query-endpoints-yet.md` — explicit note that queries are `epic-14`; this epic is ingestion-only.
- `06-append-only-enforcement.md` — repository-level enforcement; architecture-lint fixture.

**`README.md` updates required:**

- Add a `event-store-microservice` row to the **Services** table.
- **System diagram**: add the new event-store box bound to the new `ris.events` topic exchange via the firehose + audit queues.
- New **Audit + event store** section describing the dual-publish topology and what the two tables contain.

**`CLAUDE.md` updates required:**

- Add `apps/event-store-microservice/` to the Architecture section's app tree.
- Add a new section **Event-store microservice (`apps/event-store-microservice/src/`)** mirroring the per-module template documentation block.
- Update **Shared Libraries → messaging** to document the new `RIS_EVENTS_TOPIC` exchange constant and the `#.#` subscription convention.
- Update **Operational notes** with a bullet on the at-least-once + idempotent-consumer guarantee.

**Exclusions Register documents owned by this epic:** None (all under `epic-15`).

## Tasks (decomposition hint)

1. **Scaffold the new event-store-microservice** (Nest, `nest-cli.json`, scripts, docker-compose, OTel, tracer-first-import, LoggerModule, MessagingModule, DatabaseModule with a separate logical DB `ris_eventstore`, eslint boundaries + fixture suite).
2. **Add the `domain_event` table + entity + repository (append-only) + domain spec.** Migration.
3. **Add the `audit_log_entry` table + entity + repository + domain spec.** Migration.
4. **Declare the `ris.events` topic exchange** + the two queues; wire the two consumers.
5. **Implement Ingest DomainEvent + Ingest AuditLogEntry use cases** + specs.
6. **Add dual-publish capability** to `libs/messaging/` — extend the publisher utility so every existing producer's emit goes to both its existing destination AND `ris.events` with the routing key as the topic key. Minimal-edit: add a single boolean flag to the existing publisher configuration; flip it on for every service.
7. **Replace the no-op `AUDIT_LOG_PUBLISHER` adapters** in every service (api-gateway, retail, inventory, catalog, notification) with the real RMQ adapter that publishes to `audit.staff.action`.
8. **Author the e2e tests** (firehose / audit-log / idempotency).
9. **Documentation pass.**

## Carryover Between Tasks

| Task | Entry state assumed | Carryover artifacts produced (never under `tmp/`) |
|---|---|---|
| 1 | All prior epics through `epic-10` complete; producer services emit events. | New `apps/event-store-microservice/`; updated `nest-cli.json`, `package.json`, `docker-compose.yml`, OTel config, eslint config; `01-…md`. |
| 2 | Task 1 complete; new microservice boots empty. | `domain_event.entity.ts`, mapper, repository, spec, migration; `06-…md` (partial). |
| 3 | Task 2 complete. | `audit_log_entry.entity.ts`, mapper, repository, spec, migration. |
| 4 | Tasks 1–3 complete. | Topic exchange declaration; two consumer files; queue bindings; `02-…md`. |
| 5 | Tasks 1–4 complete. | Two ingestion use cases + specs; `03-…md`. |
| 6 | Tasks 1–5 complete; all producer publishers exist. | Updated publisher utility in `libs/messaging/`; per-service publisher config tweaks; routing-key constant for `audit.staff.action`. |
| 7 | Task 6 complete. | New real adapters under each service's `infrastructure/audit/`; module bindings switched; `04-…md`. |
| 8 | Tasks 1–7 complete. | Three new e2e test files. |
| 9 | All prior tasks complete. | Updated README, CLAUDE.md, eslint fixtures; `05-…md`, `06-…md` complete. |

## Exit Criteria

- [ ] `yarn lint` passes.
- [ ] `yarn test:unit` passes; new specs + updated adapter specs across all services green.
- [ ] `yarn test:e2e` passes; three new e2e files green.
- [ ] `docker compose up -d && yarn migration:run && yarn start:dev` boots all six services (the five existing + event-store); `ris.events` exchange present on RabbitMQ; both queues bound.
- [ ] After a Place Order, querying `event-store-microservice`'s DB (via direct SQL — query endpoints land in `epic-14`) shows `domain_event` rows for every routing key produced in the chain.
- [ ] After an `Assign Role` admin action, querying the `audit_log_entry` table shows the expected row with before/after snapshots.
- [ ] Republishing the same event twice produces exactly one `domain_event` row (idempotency proof).
- [ ] All producer services have their `AUDIT_LOG_PUBLISHER` bindings switched from no-op to real RMQ adapter; the no-op adapter file is deleted from each service.
- [ ] Per-task docs present under `docs/implementation/epic-11-event-store-and-audit-log/`.
- [ ] `README.md` Services + System diagram + Audit/event-store section added; `CLAUDE.md` event-store section added.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`.

## Self-Containment Notice

> Tasks generated from this epic must produce outputs that contain no references to anything under `tmp/`. The orchestration scratch space is not part of the final deliverable.
