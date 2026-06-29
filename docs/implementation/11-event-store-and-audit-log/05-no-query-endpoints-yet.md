# Ingestion only — no query endpoints yet

This document records the **deliberate scope boundary** of the event-store capability: it
*captures and stores* the event firehose and the staff audit log, and it stops there. There
is **no read/query surface** over the two logs in this capability — no HTTP route, no RPC
handler, no reporting view. This is a conscious sequencing decision, not an oversight, and
this note exists so a later reader does not mistake the missing query path for a defect.

For the surrounding machinery this scope note sits on top of, see its siblings: the
[microservice scaffold + isolated database](./01-new-event-store-microservice-scaffold.md),
the [`ris.events` topic exchange + dual-publish fan-out](./02-topic-exchange-ris-events-and-dual-publish.md),
the [domain-event ingestion + idempotency](./03-domainevent-ingestion-and-idempotency.md),
the [audit-log ingestion + publisher swap](./04-auditlog-ingestion-and-publisher-swap.md),
and the [append-only enforcement](./06-append-only-enforcement.md) — plus
[ADR-034](../../adr/034-isolated-eventstore-database.md) (the isolated `ris_eventstore`
database) and [ADR-035](../../adr/035-event-store-firehose-topic-exchange.md) (the firehose
topic exchange).

## 1. What this capability delivers

The capability closes the **write side** of the event store end to end. Concretely, the
following are live and exercised by the unit and e2e suites:

- **Two append-only tables in the isolated `ris_eventstore` database** (ADR-034), reached
  over a second TypeORM connection (`DatabaseModule.forRootWithUrl(..., 'EVENTSTORE_DATABASE_URL')`)
  with its own migration pipeline (`yarn migration:run:eventstore`):
  - **`domain_event`** — the firehose log. A verbatim capture of every business event
    published on the bus, one row per event, keyed for idempotency on the composite UNIQUE
    `(producer, event_type, aggregate_id, occurred_at, correlation_id)`.
  - **`audit_log_entry`** — the staff audit trail. One row per staff mutation, carrying the
    actor, the action, the affected entity, and the `before`/`after` snapshots; no dedupe
    key (two identical actions a moment apart are two real events).
- **The firehose ingestion path.** Producers **dual-publish** every event onto the
  `ris.events` topic exchange (the existing default-exchange emit is preserved, so the real
  consumers are untouched — see
  [02](./02-topic-exchange-ris-events-and-dual-publish.md)). The event store binds **one**
  queue `event_store_firehose_queue` to `ris.events` with the catch-all `#`, and a single
  context-root `FirehoseConsumer` dispatches each message by its routing key:
  - `audit.staff.action` → `IngestAuditLogUseCase` → `audit_log_entry`;
  - every other routing key → `IngestDomainEventUseCase` → `domain_event`.
- **At-least-once-safe, crash-safe ingestion.** The bus is at-least-once
  ([ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)); a redelivery of a domain
  event collides with the composite UNIQUE and is swallowed as an idempotent no-op, so the
  firehose is a faithful (non-duplicating) capture. The consumer never rethrows from its
  `@EventPattern` ([ADR-011](../../adr/011-notifier-port-and-adapters.md) §7) — a malformed
  payload is warn-logged and dropped rather than nacked into a redelivery loop.

In short: anything mirrored onto `ris.events` reliably lands in exactly one of the two
tables, once.

## 2. What this capability deliberately does **not** deliver

All three of the following are **out of scope here** and are named as later capabilities so
the boundary is explicit:

### 2.1 No read / query endpoints over the two logs

There is **no HTTP route and no RPC handler** that returns `domain_event` or
`audit_log_entry` rows. The repository ports already declare a single read each —
`IDomainEventRepositoryPort.listByCorrelationId(...)` and
`IAuditLogRepositoryPort.listByActor(...)` — and both are implemented (newest-first), so the
read *seam* is complete and the data shape is settled. But **no use case calls them and no
controller exposes them.** A real query surface (by correlation id, by actor, by aggregate,
by time range; pagination; a staff-gated reporting/audit-browse API at the gateway) is a
distinct future capability that builds on these declared reads.

The event-store microservice therefore has **no HTTP surface at all** — it is RMQ-only, a
pure sink. The e2e suites that prove ingestion read the rows by **direct SQL** (§3) precisely
because no query endpoint exists to read them through.

### 2.2 No retention, archival, or purge

The two logs grow without bound; nothing trims them. There is **no retention policy, no
age-range archival, and no purge job.** This is intentional, and the isolation in ADR-034
exists partly to make it tractable later: because `ris_eventstore` is a separate schema, a
future capability can truncate or archive whole age ranges of the firehose **independently**
of the operational `retail_db`, without touching live order/inventory data. Note that purge
is the *only* legitimate way to remove rows — the logs are append-only
([06](./06-append-only-enforcement.md)), so individual rows are never updated or deleted; a
correction is always a *new* event, never an edit to a stored one.

### 2.3 No event-sourced replay or state rebuild

`domain_event` is an **audit/observability capture**, not an event-sourcing journal. Nothing
reads it back to **reconstruct or rebuild** the state of any aggregate, and the operational
services do **not** treat it as their source of truth — each aggregate's own tables in
`retail_db` remain authoritative. There is no projection rebuild, no replay-to-rehydrate, and
no consumer that folds the firehose back into state. If event-sourced rebuild ever becomes a
requirement, it is a separate design on top of this capture, not an implicit feature of it.

## 3. How to inspect the logs today

Until a query surface exists, the supported way to read the two logs is **direct SQL against
the isolated `ris_eventstore` schema**. With the local docker infrastructure up:

```bash
# The most recent firehose events (newest first)
docker exec mysql mysql -uretail -pretailpass ris_eventstore \
  -e "SELECT id, producer, event_type, aggregate_type, aggregate_id, correlation_id, occurred_at \
      FROM domain_event ORDER BY id DESC LIMIT 20;"

# Every captured event for one correlation id (e.g. a single Place Order request chain)
docker exec mysql mysql -uretail -pretailpass ris_eventstore \
  -e "SELECT event_type, producer, aggregate_type, aggregate_id, occurred_at \
      FROM domain_event WHERE correlation_id = '<correlation-id>' ORDER BY occurred_at;"

# The staff audit trail, newest first (note: 'before'/'after' are backticked — reserved words)
docker exec mysql mysql -uretail -pretailpass ris_eventstore \
  -e "SELECT id, actor_id, actor_type, action, entity_type, entity_id, occurred_at \
      FROM audit_log_entry ORDER BY id DESC LIMIT 20;"

# Everything a given staff actor did
docker exec mysql mysql -uretail -pretailpass ris_eventstore \
  -e "SELECT action, entity_type, entity_id, occurred_at \
      FROM audit_log_entry WHERE actor_id = '<staff-uuid>' ORDER BY occurred_at DESC;"
```

The e2e suites under `test/event-store-*.e2e-spec.ts` follow exactly this approach — they open
a TypeORM `DataSource` on `EVENTSTORE_DATABASE_URL` (with `timezone: 'Z'`, mirroring the
writer so the UTC `occurred_at` wall-clock round-trips) and assert on the rows directly. That
read seam in the tests is the closest thing to a query API today; promoting it to a real,
staff-gated endpoint is the next capability.
