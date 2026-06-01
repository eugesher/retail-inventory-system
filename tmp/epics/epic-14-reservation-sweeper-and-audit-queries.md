---
id: epic-14
title: Hardening — Reservation TTL sweeper + AuditLog and DomainEvent query endpoints
source_stages: [hardening]
depends_on: [epic-07, epic-11]
microservices: [api-gateway, inventory-microservice, event-store-microservice]
task_subfolder: tmp/tasks/epic-14-reservation-sweeper-and-audit-queries/
docs_subfolder: docs/implementation/14-reservation-sweeper-and-audit-queries/
---

# Epic 14 — Hardening — Reservation TTL sweeper + AuditLog and DomainEvent query endpoints

## Goal

Close two Stage-3 hardening items the report names. (1) Add the background **Reservation TTL sweeper** that periodically flips `active` reservations whose `expiresAt < now()` to `expired`, releases the held `quantityReserved`, writes a `release`-type StockMovement, emits `StockReleased`, and invalidates the relevant stock cache keys — at a configurable cadence (`RESERVATION_SWEEP_INTERVAL_SECONDS`, default `60`). (2) Add the **AuditLog + DomainEvent query endpoints** on the event-store-microservice (via api-gateway proxy) so operators can search audit history by actor / entity / time-range / action and trace events by aggregate / correlation-id. After this epic, the system can detect and recover stranded reservations automatically, and an admin can answer "who cancelled this order?" or "what events did correlationId X produce?" from the admin UI.

## In-Scope Entities and Operations

- **No new entities.** Reuses `Reservation` (from `epic-07`), `StockMovement` (epic-07), `DomainEvent` (epic-11), `AuditLogEntry` (epic-11).
- **Operations:**
  - **Sweep Expired Reservations** (System; cron) — runs every `RESERVATION_SWEEP_INTERVAL_SECONDS`. Picks up to `RESERVATION_SWEEP_BATCH_SIZE` (default `200`) rows where `status='active' AND expires_at < now()`, processes them in batches of `RESERVATION_SWEEP_TRANSACTION_SIZE` (default `25` — bounds transaction size to keep locks short). Per-batch: for each Reservation, in one transaction: flip `status='expired'`; decrement `stock_level.quantityReserved` (with OCC retry from `epic-12`); insert `release`-type `stock_movement` row with `reasonCode='reservation-ttl-expired'`. Post-commit: emit `inventory.stock.released` per affected `(variantId, stockLocationId)` and invalidate the corresponding stock cache via `withInvalidation(...)`.
  - **Manual Sweep** (User; `inventory:adjust`) — admin endpoint that triggers a sweep on demand (useful for debug); same logic, single invocation.
  - **Query AuditLogEntry** (User; `audit:read`) — filter by `actorId`, `entityType`, `entityId`, `action`, `from`, `to`; paginated.
  - **Query DomainEvent** (User; `audit:read`) — filter by `eventType`, `aggregateType`, `aggregateId`, `correlationId`, `from`, `to`; paginated.
  - **Get Trace by Correlation Id** (User; `audit:read`) — combined view: all DomainEvent rows + all AuditLogEntry rows for a given `correlationId`, sorted by `occurredAt`.
  - **Cleanup `idempotency_key` rows** (System; cron — colocated with this epic per the forward note in `epic-12` task 12) — every 10 minutes, DELETE rows where `expires_at < now()` from each producing service's `idempotency_key` table.

## Non-Goals

- **Event-sourced state replay** — out of scope (per the report's caveats: read-model rebuilds are scale-out concerns).
- **Export to S3 / cold storage** — out of scope.
- **Long-term retention/archival policy** — out of scope (DomainEvent + AuditLogEntry are append-only and grow unbounded; partitioning + archival is future work).
- **Full-text search over `before`/`after` JSON columns** — out of scope. Filters operate on indexed columns only.
- **Real-time push of event firehose to admin UI** — out of scope.
- **Customer-facing "my activity history" — out of scope (the report's customer-side activity is implicit in their order list).

## Architectural Decisions Honored

- **Open Question Q9** — Reservation TTL ~15 minutes with explicit refresh on cart interaction and immediate commit on order placement. The sweeper closes the loop: stranded `active` reservations (no refresh, no commit, no manual release) are reaped automatically.
- **Cross-Cutting "Concurrency & consistency":** the sweeper's StockLevel decrement uses the OCC mechanism from `epic-12`. The sweeper does NOT take pessimistic locks — multiple sweeper instances racing on the same Reservation row are handled by the OCC token + the `status='active'` precondition (a Reservation already flipped to `expired` by another worker is skipped silently).
- **Cross-Cutting "Event emission":** `StockReleased` is the canonical event (reused; no new routing key). Per-Reservation emission groups by `(variantId, stockLocationId)` to coalesce multiple released reservations on the same stock level into fewer events when feasible — but groupedness is best-effort, not a contract; consumers must tolerate per-reservation emission.
- **Cross-Cutting "Soft delete vs hard delete":** Reservation rows are **live ephemeral** — the sweeper-driven `expired` rows are retained for a configurable window (`RESERVATION_RETENTION_DAYS`, default `30`) for forensic queries, then purged by a future cleanup task.
- **Cross-Cutting "Auditability":** sweeper runs emit a single `info` log line with the batch size + duration. Per-row releases produce `inventory.stock-movement.recorded` rows (already routed to the event-store via the firehose from `epic-11`), so the audit trail is complete without extra work.
- **ADR-016 + ADR-022 + ADR-023** (cache): sweeper-driven invalidation routes through `withInvalidation(work, resolveItems, opts)` so the post-commit ordering rule holds.
- **ADR-019** (TypeORM + MySQL): no new tables; uses `@nestjs/schedule` for the cron registration.
- **ADR-010** (RBAC): query endpoints behind `audit:read` (already seeded). Manual sweep behind `inventory:adjust`.

## Persistence Changes

**No new tables.** No new columns.

**Indexes** (verifying epic-07 indexes still cover sweep query):

- `reservation (status, expires_at)` — added by `epic-07`. Used by the sweeper's `SELECT … WHERE status='active' AND expires_at < ? LIMIT batch_size` query.
- `domain_event (event_type, occurred_at DESC)`, `domain_event (aggregate_type, aggregate_id, occurred_at DESC)`, `domain_event (correlation_id)` — added by `epic-11`. Used by query endpoints.
- `audit_log_entry (actor_id, occurred_at DESC)`, `audit_log_entry (entity_type, entity_id, occurred_at DESC)`, `audit_log_entry (action, occurred_at DESC)`, `audit_log_entry (correlation_id)` — added by `epic-11`. Used by query endpoints.

If any of the above indexes turn out missing in epic-11's actual implementation, add them here in a fresh migration.

## Eventing / Messaging

- **No new routing keys.**
- **Sweeper emits:** `inventory.stock.released` per `(variantId, stockLocationId)` group — reuses the existing routing key from `epic-07`; payload includes `reason: 'expired'` (one of the values already enumerated by `epic-07`).
- **New RPC** on event-store-microservice for the audit-query path (via api-gateway proxy):
  - `audit.event.query` — request `{ filters, pagination }` → response `{ rows, total, page, pageSize }`.
  - `audit.entry.query` — same shape.
  - `audit.trace.by-correlation` — request `{ correlationId }` → response `{ events: [...], auditEntries: [...] }`.
  - Queue: `event_store_query_queue` (RPC); pattern: dotted `audit.*`.

## API Surface

**New HTTP endpoints in `api-gateway`** (new `modules/audit/` proxy module):

| Method | Path | Body / params | Auth | Notes |
|---|---|---|---|---|
| `GET` | `/api/audit/events` | query: `?eventType=&aggregateType=&aggregateId=&correlationId=&from=&to=&page=&pageSize=` | bearer + `audit:read` | DomainEvent query; max pageSize 100. |
| `GET` | `/api/audit/entries` | query: `?actorId=&entityType=&entityId=&action=&from=&to=&page=&pageSize=` | bearer + `audit:read` | AuditLogEntry query. |
| `GET` | `/api/audit/trace/:correlationId` | — | bearer + `audit:read` | Combined trace view. |
| `POST` | `/api/inventory/reservations/sweep` | optional `{ batchSize? }` | bearer + `inventory:adjust` | Manual sweep trigger. |

**Kulala HTTP files** (under `http/`):

- **`http/audit.http`** — NEW; covers the three query endpoints with parameter examples.
- **`http/inventory.http`** — EXTENDED with the manual sweep endpoint.

## Test Strategy

**Unit tests:**

- `apps/inventory-microservice/src/modules/stock/application/use-cases/spec/sweep-expired-reservations.use-case.spec.ts` — picks correct rows; batch + transaction sizing respected; OCC retry on StockLevel decrement; emits per-group released events; cache invalidation routed through `withInvalidation`.
- `apps/event-store-microservice/src/modules/domain-events/application/use-cases/spec/query-events.use-case.spec.ts` — filter combinations; pagination; default sort by `occurredAt DESC`.
- `apps/event-store-microservice/src/modules/audit-log/application/use-cases/spec/query-entries.use-case.spec.ts` — same.
- `apps/event-store-microservice/src/modules/audit-log/application/use-cases/spec/trace-by-correlation.use-case.spec.ts` — combined sort; missing correlationId returns empty arrays not 404.

**E2E tests:**

- `test/reservation-sweeper.e2e-spec.ts`:
  1. Place a cart line (reserves stock).
  2. Manually expire the reservation by setting `expires_at = now() - 1 minute` directly in the DB (test-only escape hatch — documented in the test).
  3. Trigger manual sweep via the admin endpoint.
  4. Assert Reservation `status='expired'`, `stock_level.quantityReserved` decremented, `stock_movement` row of type `release` with `reasonCode='reservation-ttl-expired'`, `inventory.stock.released` emitted (verified via the event-store's `domain_event` table).
- `test/reservation-sweeper-cron.e2e-spec.ts`: lower the env `RESERVATION_SWEEP_INTERVAL_SECONDS=2` for the test; expire a reservation; wait 3 seconds; assert it was swept automatically.
- `test/audit-event-query.e2e-spec.ts`: place an order (produces a known event chain); query `/api/audit/events?aggregateType=order&aggregateId=...`; assert the chain.
- `test/audit-entry-query.e2e-spec.ts`: admin performs an `Assign Role`; query `/api/audit/entries?action=iam:assign`; assert presence.
- `test/audit-trace-correlation.e2e-spec.ts`: place an order with a known correlationId; query `/api/audit/trace/:correlationId`; assert both event rows + audit-log rows for that correlationId are returned, sorted by occurredAt.
- `test/idempotency-key-cleanup.e2e-spec.ts`: insert an expired idempotency_key row; wait for the cron; assert it's gone.

**Concurrency tests:** the sweeper-vs-Cart-write race — a Cart Remove Line is in flight that releases the same Reservation the sweeper is about to expire. OCC + the `status='active'` precondition ensures exactly one of the two completes successfully; the other observes the post-state and treats it as a no-op (no double-decrement of `quantityReserved`).

**Seed data required:**

- `RESERVATION_SWEEP_INTERVAL_SECONDS=60`, `RESERVATION_SWEEP_BATCH_SIZE=200`, `RESERVATION_SWEEP_TRANSACTION_SIZE=25` in `.env.example`.
- `RESERVATION_RETENTION_DAYS=30`.
- `IDEMPOTENCY_KEY_CLEANUP_INTERVAL_MINUTES=10`.

## Documentation Deliverables

**Per-task markdown files** under `docs/implementation/14-reservation-sweeper-and-audit-queries/`:

- `01-reservation-sweeper-design.md` — cadence, batch sizing, transaction sizing rationale (short locks); OCC interaction with the cart-write path.
- `02-sweeper-cron-and-coalesced-emit.md` — how `@nestjs/schedule` registers the cron; the per-group emit decision; consumer obligation to handle per-row.
- `03-manual-sweep-admin-endpoint.md` — debug-mode usage.
- `04-audit-event-query-shape-and-indexes.md` — filter combinations; index reliance; pagination caps.
- `05-audit-entry-query-and-trace-by-correlation.md`.
- `06-idempotency-key-cleanup-cron.md` — co-located in this epic per the `epic-12` forward note.
- `07-http-files-audit-and-sweep.md`.

**`README.md` updates required:**

- New **Reservation TTL sweeper** subsection under **Caching** or under a new **Background jobs** section — covers cadence + observable signals.
- New **Audit + event store queries** subsection under **API** — covers the three new query endpoints with example URL params.
- **Environment variables** extended with sweeper + cleanup knobs.

**`CLAUDE.md` updates required:**

- New section: **Background jobs (cron)** listing the three crons (reservation sweeper, idempotency cleanup, notification-delivery cleanup if not already there) with their cadence env vars.
- Extend **Event-store microservice** section with the new query controllers/use cases.
- Add new routing-key-RPC entries for `audit.event.query` / `audit.entry.query` / `audit.trace.by-correlation`.

**Exclusions Register documents owned by this epic:** None (all under `epic-15`).

## Tasks (decomposition hint)

1. **Implement Sweep Expired Reservations use case** in inventory-microservice + spec; batching + OCC + invalidation.
2. **Register the sweeper cron** via `@nestjs/schedule`.
3. **Add manual-sweep admin endpoint** + extend `http/inventory.http`.
4. **Implement Query DomainEvent use case + Query AuditLogEntry use case + Trace by Correlation use case** in event-store-microservice + RPC handlers + specs.
5. **Add api-gateway `modules/audit/` proxy module** + controllers + DTOs + pipes.
6. **Co-locate the idempotency_key cleanup crons** in retail-microservice + inventory-microservice (per the forward note from `epic-12`).
7. **Author `http/audit.http`.**
8. **Author the six e2e tests.**
9. **Documentation pass.**

## Carryover Between Tasks

| Task | Entry state assumed | Carryover artifacts produced (never under `tmp/`) |
|---|---|---|
| 1 | `epic-07`, `epic-11`, `epic-12` complete. | Sweep use case + spec; `01-…md`. |
| 2 | Task 1 complete. | `@nestjs/schedule` registered cron + boot wiring; `02-…md`. |
| 3 | Tasks 1–2 complete. | Manual endpoint + DTO; extended `http/inventory.http`; `03-…md`. |
| 4 | `epic-11` complete; event-store has the tables. | Three use cases + RPC handlers + specs in event-store; queue + routing keys added in messaging lib. |
| 5 | Task 4 complete. | New `apps/api-gateway/src/modules/audit/` per-module hexagonal layout; controllers; DTOs; pipes; `04-…md`, `05-…md`. |
| 6 | `epic-12` complete. | Crons in retail + inventory; specs; `06-…md`. |
| 7 | Task 5 complete. | `http/audit.http`; `07-…md`. |
| 8 | Tasks 1–7 complete. | Six new e2e files. |
| 9 | All prior tasks complete. | Updated README + CLAUDE.md + fixtures. |

## Exit Criteria

- [ ] `yarn lint` passes.
- [ ] `yarn test:unit` passes; new specs green.
- [ ] `yarn test:e2e` passes; six new e2e files green; the cron-driven test runs reliably under the test infra timing (interval set to 2s for tests).
- [ ] Letting an Add-to-Cart sit untouched for ~`RESERVATION_TTL_MINUTES` results in the sweeper reaping it automatically; `quantityReserved` drops; stock-released event observed in the event-store.
- [ ] `GET /api/audit/events?correlationId=<id>` returns the full chain for a placed order including events from every producing service.
- [ ] `GET /api/audit/entries?action=iam:assign` returns the historical role-assignment rows.
- [ ] Per-task docs present under `docs/implementation/14-reservation-sweeper-and-audit-queries/`.
- [ ] `README.md` Background-jobs + Audit-queries sections added; `CLAUDE.md` cron + query sections added.
- [ ] No file under `docs/`, `apps/`, `libs/`, `http/`, `README.md`, or `CLAUDE.md` references any path under `tmp/`.

## Self-Containment Notice

> Tasks generated from this epic must produce outputs that contain no references to anything under `tmp/`. The orchestration scratch space is not part of the final deliverable.
