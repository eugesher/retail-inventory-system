# Append-only enforcement for the event store's two logs

This document covers the event store's two persistent logs — `domain_event` (the event
firehose) and `audit_log_entry` (the staff audit trail) — and the central property they
share: they are **append-only**. A row is written once and is **never updated, never
deleted**. This work ships the domain value objects, the entities + mappers, the two
append-only repository ports + adapters, the unit specs, and the two `ris_eventstore`
migrations. It does **not** wire ingestion (the firehose consumer + the ingest use
cases are a later capability); the seams are built so that later work adds *behaviour*,
never *plumbing*.

Both tables live in the isolated `ris_eventstore` schema, not the operational
`retail_db` — see [`01-new-event-store-microservice-scaffold.md`](./01-new-event-store-microservice-scaffold.md)
and [ADR-034](../../adr/034-isolated-eventstore-database.md). The firehose topic
exchange that will feed them is described in
[`02-topic-exchange-ris-events-and-dual-publish.md`](./02-topic-exchange-ris-events-and-dual-publish.md)
and [ADR-035](../../adr/035-event-store-firehose-topic-exchange.md).

## 1. Why these two logs are append-only

The two logs are systems of record whose entire value is that **history is immutable**:

- **Audit integrity.** An audit trail (`audit_log_entry`) that can be edited or deleted
  is no audit at all — the whole point of "who did what, when" is that nobody, including
  an operator with database access through the application, can quietly rewrite it after
  the fact. The only legitimate operation is *append a new fact*.
- **The firehose is a captured ledger.** `domain_event` is a verbatim capture of events
  that already happened and were already published on the bus. There is no notion of
  "correcting" a past event — a later correction is itself a *new* event. Mutating a
  captured row would desynchronise the store from the reality it recorded.

This is the system-wide **"never delete, never update"** posture for log-shaped data,
the same one the inventory `stock_movement` ledger takes
([ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md) §2).
Retention is handled by *truncation/archival of whole age ranges* (a future operational
capability — the isolation in ADR-034 exists precisely so the event log can be
truncated independently), never by row-level deletes.

## 2. How append-only is enforced

The property is enforced in **four** independent layers, so it does not rely on any
single guard or on developer discipline:

### 2.1 The domain models are frozen value objects

`DomainEvent` (`modules/domain-events/domain/domain-event.model.ts`) and `AuditLogEntry`
(`modules/audit-log/domain/audit-log-entry.model.ts`) are immutable, read-only value
objects in the `StockMovement` style:

- every field is `public readonly`;
- the constructed instance is `Object.freeze`-d, so an attempted post-construction write
  throws (or silently no-ops) at runtime, not just at compile time;
- there are **no mutators** — the only methods are the two static factories `create`
  (write path, `id: null`) and `reconstitute` (load path); the prototype carries nothing
  but its constructor;
- neither is an `AggregateRoot`, and neither records domain events — they are inert
  records, not behavioural aggregates.

The models accept whatever the bus carries (every nullable field genuinely arrives null
for some real event — `LoginFailed` has no actor, `ipAddress` is always null today). The
only invariants enforced are the ones the column types make load-bearing: a non-empty
`eventType`/`producer` for `DomainEvent`, and a non-empty `action` plus an
`actorType ∈ {staff-user, system}` for `AuditLogEntry`. A violation is an *internal*
caller bug (the ingest use case shapes and validates the wire payload first), so it
throws a plain `Error`, not a typed domain exception. Field-level malformed-input
rejection (drop + warn) is the ingest use case's responsibility, a later capability.

### 2.2 The repositories expose only `append` + reads

`DomainEventTypeormRepository` and `AuditLogEntryTypeormRepository` implement their
ports **directly**. They deliberately do **not** extend `BaseTypeormRepository`, whose
public `save` / `softDelete` surface would contradict append-only. The repository
interface (`IDomainEventRepositoryPort` / `IAuditLogRepositoryPort`) declares only
`append(...)` plus a future read — there is **no** `save` / `update` / `delete` /
`softDelete` method anywhere on the seam, so an UPDATE or DELETE is *not expressible*
against these repositories. The single mutating verb, `append`, uses TypeORM's `insert`
(never `save`-with-id semantics), so there is not even a preload-by-id round trip that
could turn into an update. This is the `stock_movement` ledger precedent
([ADR-030](../../adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md) §2,
[ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md)): the repositories
are the only `@InjectRepository` sites for their entity, and they return domain types
only — no TypeORM type leaks past the persistence layer.

### 2.3 No `updated_at` / `deleted_at` columns at all

The `BaseEntity` from `@retail-inventory-system/database` carries
`created_at` / `updated_at` / `deleted_at`. The `stock_movement` ledger extends it and
leaves `updated_at`/`deleted_at` *inert by construction* — present but never written.
The event-store entities go one step further: they **do not extend `BaseEntity`** and
**do not declare those columns at all**. There is therefore no place for an update
timestamp or a soft-delete tombstone to live; append-only is expressed in the table
shape itself. Each table has its own BIGINT auto-increment PK and an ingest timestamp
`received_at` (DB-defaulted to `CURRENT_TIMESTAMP(3)`) beside `occurred_at` (the
producer's emit time threaded from the wire). The two differ by bus + ingest latency.

### 2.4 (Forward note) An architecture-lint fixture will guard the shape

The repository shape above — append-only adapters that implement the port directly and
expose no `save`/`update`/`delete` — is the kind of structural rule the project pins
with an `eslint-plugin-boundaries` fixture so a regression fails CI rather than slipping
through review (the
[ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md) bumper-fixture
approach). That lint fixture is added with the documentation/lint pass for this
capability; this note records the intent so the guarantee is not left implicit.

## 3. The `domain_event` idempotency key and `correlation_id` coalescing

The bus is **at-least-once** ([ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)):
a consumer can legitimately receive the same event twice (a redelivery after a transient
nack, a reconnect mid-ack). For the firehose to be a faithful capture, a redelivery must
**not** produce a second stored row. The guard is a composite UNIQUE index on
`domain_event`:

```
UNIQUE (producer, event_type, aggregate_id, occurred_at, correlation_id)
```

These five fields together identify "the same event from the same producer at the same
instant". On a redelivery the INSERT collides with the already-stored row and MySQL
raises `ER_DUP_ENTRY`; `DomainEventTypeormRepository.append` catches exactly that error
and returns `{ inserted: false }` — an **idempotent no-op**, never a thrown exception
(the `ReservationTypeormRepository` ER_DUP_ENTRY-translation precedent). A clean insert
returns `{ inserted: true }`. Any other failure propagates.

There is one MySQL subtlety the ingest must honour. **MySQL treats `NULL`s as distinct
in a UNIQUE index** — two rows whose `correlation_id` is `NULL` do *not* collide, even
if every other key column matches. Many events carry no correlation id, so if the column
were stored as `NULL` a redelivery of such an event would slip past the UNIQUE and
duplicate. The resolution: the ingest use case **coalesces an empty wire `correlationId`
to the empty string `''`** (not `NULL`) before append, so a redelivery actually
collides. The column itself stays **nullable** to honour the wire contract (the
correlation id is genuinely optional); the coalescing is an ingest-time write decision,
owned by the ingest use case (a later capability). This document records the decision so
that work honours it.

`audit_log_entry`, by contrast, has **no** dedupe key: two identical staff actions a
second apart are two real, distinct events, so there is nothing to collide on. Its
`append` simply inserts and lets the BIGINT PK autoincrement, always reporting
`{ inserted: true }` on success. The `{ inserted }` return shape is shared between the
two ports so a later capability could introduce an audit dedupe key without changing the
signature.

## 4. What this work ships, and what it defers

**Ships:** the `DomainEvent` / `AuditLogEntry` models (+ specs), the
`DomainEventEntity` / `AuditLogEntryEntity` + mappers, the
`DOMAIN_EVENT_REPOSITORY` / `AUDIT_LOG_REPOSITORY` ports and their append-only
TypeORM adapters, the two ports bound + `DatabaseModule.forFeature(...)` wired in each
context module, the entity list registered on the eventstore connection in
`app.module.ts`, and the two `ris_eventstore` migrations
(`CreateDomainEventTable`, `CreateAuditLogEntryTable`).

**Defers (later capabilities):** the firehose consumer + the in-consumer dispatch by
routing key, the ingest use cases (including the `correlation_id = ''` coalescing in §3)
and their idempotency proof, any read/query HTTP path (the `listByCorrelationId` /
`listByActor` signatures are declared so the seam is complete, but no endpoint is built
against them), and the producer dual-publish fan-out across the domain-event publishers.
