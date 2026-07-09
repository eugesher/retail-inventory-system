# ADR-039: The audit-and-event-store query surface

- **Date**: 2026-07-10
- **Status**: Accepted

---

## Context

The event store ([ADR-034](034-isolated-eventstore-database.md)) sinks two append-only logs
into its isolated `ris_eventstore` schema: `domain_event`, the firehose copy of every
business event the system publishes, and `audit_log_entry`, the staff audit trail. Both have
been filling since the `#` binding onto the `ris.events` topic exchange landed
([ADR-035](035-event-store-firehose-topic-exchange.md)).

**Nothing reads them.** The service has no `presentation/` layer, no HTTP surface, and both
repository ports expose `append` and nothing else. The only reader in the repository is a
test's raw SQL. An operator asking "what happened to order 42?", "what has this staff member
done?", or "show me everything that request touched" has no answer short of a MySQL client.

That is a real gap in an audit capability: an audit log that cannot be interrogated is a
liability, not a control. It is also an *unusual* gap, because the event store deliberately
grew no read seam — ADR-034 called querying "a later, low-frequency capability," and the two
speculative reads that once existed (`listByCorrelationId` on the firehose port, `listByActor`
on the audit port) were deleted unwired, because their shapes were wrong: newest-first,
unbounded, unfiltered.

`audit:read` already exists as a `PermissionCodeEnum` member and is already seeded onto the
`admin` role. The permission was minted before anything could be read with it.

Two properties of the tables shape everything below. `domain_event` is the highest-volume,
fastest-growing table in the system and only ever grows. And both tables carry a JSON column
(`payload`; `before` / `after`) that no index can serve.

## Decision

### 1. Two filtered, paginated queries and one unpaginated trace

The event store gains a read surface of exactly three application use cases:

| Use case | Answers | Order |
| --- | --- | --- |
| `QueryDomainEventsUseCase` | "what did the system do" | `occurred_at DESC, id DESC` |
| `QueryAuditLogEntriesUseCase` | "what did a person do" | `occurred_at DESC, id DESC` |
| `TraceByCorrelationUseCase` | "what did this one request cause" | `occurred_at ASC, id ASC` |

The two queries are **filtered and paginated**. The firehose filter set is `eventType`,
`aggregateType`, `aggregateId`, `correlationId`, and an inclusive `occurred_at` window
(`from` / `to`); the audit filter set is `actorId`, `entityType`, `entityId`, `action`,
`correlationId`, and the same window. Every filter is optional: an absent filter contributes
no predicate, so an empty filter set reads the whole log. Both return the canonical
`IPage<T>` envelope — `{ items, total, page, size }` — with the wire asking for `pageSize` and
the page answering with `size`, exactly as `inventory.stock-movement.list` already does.

**Filters never touch the JSON columns.** Every filter names a column backed by an index that
already exists (the seven created by the two eventstore migrations). `payload` / `before` /
`after` are *returned* but never *searched*. A `LIKE` or a `JSON_EXTRACT` predicate is
unindexable, so it degrades into a full scan of an append-only table whose row count only
climbs — the one shape of query this schema must never make easy. Deep-paging that same
table is the accepted cost of offset pagination (see Consequences); a full scan on every
request would not be.

The **trace is unpaginated and ascending**. A correlation id scopes exactly one request's
causal chain, so the result set is bounded and small — there is nothing to page — and a
timeline reads forward, the opposite of what the operator's "what just happened" default
wants. It returns the two logs as two independently-ordered arrays, never merged into one
interleaved stream: they answer different questions and their ids live in different spaces.

**An unknown correlation id yields two empty arrays, never a `404`.** The absence of a trace
is not the absence of a resource.

**An inverted `from` / `to` range yields an empty page, not a rejection.** `Between(hi, lo)`
selects nothing in MySQL, which is the honest answer to a window containing no instants. The
alternative — a `400` from the use case — would require the event store to grow its first
`*DomainException` + `*ErrorCodeEnum` + `*RpcExceptionFilter` triple, three files whose only
purpose would be one message. Shape errors (a non-ISO string, an empty `targetCorrelationId`)
are the gateway DTO's business, where every other shape error in this system already lives.

**The page size is capped at 100 in the use case**, via `clampPageWindow(page, pageSize,
{ defaultPage: 1, defaultSize: 20, maxSize: 100 })`. The cap lives there, not in the gateway
DTO, so that every caller inherits it — including a direct RPC client that never passes
through the gateway, and any future caller. A DTO-side cap would be a second copy that drifts.

### 2. A dedicated `event_store_query_queue` on the default exchange

The three reads are served over RabbitMQ RPC on a **second queue**,
`event_store_query_queue`, bound to the **default exchange** (`wildcards: false`), disjoint
from the `ris.events`-bound `event_store_firehose_queue`. The event store becomes a hybrid
Nest application that connects both transports and still never listens on HTTP.

The RPC namespace is `audit.*`, in the dotted `<service>.<aggregate>.<action>` shape of
[ADR-008](008-rabbitmq-via-libs-messaging.md):

- `audit.event.query`
- `audit.entry.query`
- `audit.trace.by-correlation`

`audit.staff.action` (ADR-035) already occupies the `audit.` prefix — as an **event**, fanned
out over `ris.events`. These three are **commands**, and they never travel over that exchange.

### 3. This refines ADR-035's "two disjoint queues" rejection; it does not reverse it

ADR-035 rejected two event-store queues on the grounds that *"a single Nest app binds every
`@EventPattern` to every connected transport, so cleanly splitting disjoint pattern sets
across two queues in one app is not supported."* That reasoning is correct **for event
patterns**, and the firehose still binds one queue with a lone `#`. It does not hold for an
RPC transport, and the difference is mechanical, not stylistic. Verified against the shipped
`@nestjs/microservices` `ServerRMQ`:

- **`ServerRMQ.getHandlerByPattern` branches on `wildcards`.** With `wildcards: false` it
  delegates straight to the base class's **exact map lookup**. Only with `wildcards: true`
  does it fall through to `matchRmqPattern` over the wildcard-handler map.
- **On the query transport** (`wildcards: false`, default exchange), the app's
  `@EventPattern('#')` is registered as the literal map key `'#'`. Nothing routes a message
  there with the routing key `#`, so the entry is inert; an incoming `audit.event.query`
  resolves by exact lookup to its `@MessagePattern` handler. Nothing publishes an event onto
  this queue.
- **On the firehose transport** (`wildcards: true`, topic exchange), `ServerRMQ` binds *every*
  registered handler pattern as a routing key: `bindQueue(queue, 'ris.events', routingKey)`
  for each key in the handler map. So the three `audit.*.query` patterns **will additionally
  be bound onto `ris.events`**. This is a real, observable consequence — four bindings appear
  in the RabbitMQ management UI where one used to. They are inert: nothing publishes those
  routing keys to that exchange. `#` continues to match every event, exactly as before.
- **The failure ADR-035 named is a wildcard-matching failure** — a multi-word routing key that
  `matchRmqPattern` cannot match under `#.#`, nacked in a hot loop (see ADR-035's Editorial
  Correction). Neither transport here is asked to wildcard-match a pattern it does not own:
  the firehose owns `#` and matches events with it; the query transport matches nothing by
  wildcard at all.

Splitting **two disjoint `@EventPattern` sets** across two queues in one app remains
unsupported. Splitting **an event queue from an RPC queue** is supported, and is what this ADR
does.

### 4. The gateway proxies at `/api/audit/*`, behind `audit:read`

A `modules/audit/` proxy module in the API gateway — an RPC-fronting module with
`application/ports` + `application/use-cases` + `infrastructure/messaging` + `presentation`,
and **no `domain/`** ([ADR-009](009-port-adapter-at-the-gateway.md)). Every route is gated by
`@RequiresPermission(PermissionCodeEnum.AUDIT_READ)` — already a member, already seeded onto
`admin`, so no `PERMISSION_SEEDS` change. `audit:read` is staff-only by construction: a
customer JWT carries no `permissions` claim ([ADR-024](024-rbac-v2-staffuser-customer-and-permissions.md)).

### 5. The trace's cross-module read goes through a reader port, not a sibling import

`TraceByCorrelationUseCase` lives in the `audit-log/` module and needs `domain_event` rows,
which the sibling `domain-events/` module owns. `eslint-plugin-boundaries`
([ADR-017](017-architecture-lint-via-eslint-boundaries.md)) forbids the cross-module reach,
and the rule is not weakened.

Instead the trace reaches the table through `TRACE_DOMAIN_EVENT_READER` — a
**raw-parameterized-SQL reader port** whose adapter issues one `SELECT … FROM domain_event
WHERE correlation_id = ? ORDER BY occurred_at ASC, id ASC` through the injected
`EntityManager`. The port returns a plain row shape, deliberately **not** the sibling's
`DomainEvent` model: leaking that class through the seam would re-couple by type what the
boundary decoupled by import.

This is the seam the codebase already uses three times over — `ORDER_CART_READER` (orders → the
cart tables), `RETURN_ORDER_READER` (returns → the order tables), and `CONSENT_READER`
(notification → the gateway-owned `consent_record`). Both event-store modules share one
schema and one connection, so no join is lost and no second connection is opened.

`IDomainEventRepositoryPort` therefore gains **exactly one** method (`query`), not two: a
second `listByCorrelationId` on that port would be a dead seam — the trace does not use it,
and `query({ correlationId }, page)` already covers the paginated case.

### 6. The two `correlation_id` columns are not symmetric

- `domain_event.correlation_id` is **`NOT NULL DEFAULT ''`**. MySQL treats `NULL`s as distinct
  inside a UNIQUE, so a nullable column would have defeated the ingest dedupe key
  `(producer, event_type, aggregate_id, occurred_at, correlation_id)` on every redelivery. An
  event ingested with no correlation id therefore stores `''`, and is reachable by no trace
  and by no `correlationId` filter. The gateway DTO rejects an empty `targetCorrelationId` so
  a caller cannot ask for that bucket by accident.
- `audit_log_entry.correlation_id` **is nullable** — the audit trail has no dedupe key, so
  nothing forced it non-null. A `WHERE correlation_id = ?` never matches a null-correlation
  row, which is correct: such a row belongs to no request's causal chain.

## Alternatives Considered

- **Serve the queries on the existing `event_store_firehose_queue`.** Rejected. That queue is
  bound to `ris.events` with `wildcards: true`, so handler resolution falls back to
  `matchRmqPattern`, and the catch-all `#` matches every pattern. Correct dispatch would then
  depend on module-registration order deciding which handler `ServerRMQ` finds first — a
  correctness property resting on an ordering nobody declares. Command traffic would also ride
  an event fan-out exchange.
- **Two independent Nest application instances in one process.** Rejected: two DI containers,
  two connections to `ris_eventstore`, two logger bootstraps and two tracer concerns, for one
  queue.
- **Give the event store an HTTP surface and proxy over HTTP.** Rejected: every inter-service
  hop in this system is RabbitMQ ([ADR-020](020-rabbitmq-as-inter-service-bus.md)); an
  HTTP-speaking sixth service is a second transport topology to operate, secure, and trace.
- **Let the gateway read `ris_eventstore` directly through a reader port.** Rejected: it
  re-couples the schema ADR-034 isolated, and the gateway would hold a second database
  connection to a schema it does not own. The reader-port precedent applies *within* a
  deployable, across module lines — not across a database boundary drawn on purpose.
- **Reuse `listByCorrelationId` / `listByActor`, the two reads deleted before this work.**
  Rejected: wrong ordering for a trace (they were newest-first), no filters, no pagination.
  Resurrecting them "for symmetry" is what put them there unwired in the first place.
- **Full-text or JSON-path search over `payload` / `before` / `after`.** Rejected: no index
  can serve it, so every such query full-scans the system's largest and fastest-growing table.
  If event-body search is ever needed, it belongs in a purpose-built index, not in a `WHERE`
  clause over the write path's storage.
- **Cursor (keyset) pagination.** Rejected for now: offset pagination over an indexed,
  monotonic `(…, occurred_at DESC)` is adequate at these volumes, and a cursor would leak the
  `id` space into the gateway contract. Noted as an accepted scale limit.

## Consequences

- **Deep offsets degrade.** `skip((page - 1) * size)` makes MySQL walk and discard the skipped
  rows. On an ever-growing append-only table, page 5,000 is slow and gets slower. The 100-row
  cap bounds the payload, not the offset. Narrow with filters; the accepted fix, if it is ever
  needed, is keyset pagination.
- **The JSON columns are returned but not searchable.** An operator who needs "every event
  whose payload mentions SKU-7" must filter on indexed columns first and scan the results.
- **`domain_event` rows ingested without a correlation id (`''`) are untraceable**, forever.
  They remain reachable by `eventType` / `aggregateType` / `aggregateId` / time window.
- **The event store now provisions two queues.** `event_store_query_queue` joins
  `event_store_firehose_queue`; both must exist for the service to be healthy. The three
  `audit.*.query` routing keys additionally appear as inert bindings on `ris.events`.
- **The boot becomes hybrid** — `connectMicroservice` twice, then `startAllMicroservices` — and
  `main.ts` must keep the tracer as its first import ([ADR-007](007-pino-and-opentelemetry.md)).
  The service still never calls `app.listen()` on an HTTP port.
- **The event store still has no `*DomainException`.** An empty result is the answer to every
  question it cannot satisfy, so no error-code enum, no RPC exception filter, no HTTP status
  table. Its `*RpcExceptionFilter`-shaped hole is deliberate.
- **`audit:read` becomes reachable.** The permission has been seeded onto `admin` since the
  RBAC v2 work; this is the first capability it gates.

## References

- [ADR-034](034-isolated-eventstore-database.md) — the isolated `ris_eventstore` database and
  the append-only tables these queries read.
- [ADR-035](035-event-store-firehose-topic-exchange.md) — the `ris.events` topic exchange, the
  `#` firehose binding, and the "two disjoint queues" rejection this ADR refines for RPC.
- [ADR-008](008-rabbitmq-via-libs-messaging.md) — the dotted `<service>.<aggregate>.<action>`
  routing-key shape the `audit.*` namespace follows.
- [ADR-020](020-rabbitmq-as-inter-service-bus.md) — RabbitMQ as the only inter-service
  transport; the reason no HTTP surface is added to the event store.
- [ADR-017](017-architecture-lint-via-eslint-boundaries.md) — the cross-module isolation the
  trace's reader port respects rather than weakens.
- [ADR-009](009-port-adapter-at-the-gateway.md) — the gateway proxy-module shape (`no domain/`)
  the `modules/audit/` proxy follows.
- [ADR-024](024-rbac-v2-staffuser-customer-and-permissions.md) — `PermissionCodeEnum` as the
  single source of truth; `audit:read` is staff-only by construction.
