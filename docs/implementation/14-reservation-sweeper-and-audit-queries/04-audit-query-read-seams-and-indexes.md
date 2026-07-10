# Making the event store answer questions

The event-store microservice has been recording everything and telling nobody. This note
describes the read seams that change that: two filtered, paginated queries over its two
append-only logs, and one correlation-id trace that stitches them together.

Nothing here is a transport — only application use cases, the repository methods they call, and
the wire contracts they return. The queue and the RPC namespace that carry them are decided in
[ADR-039](../../adr/039-audit-and-event-store-query-surface.md) §2 and described in the sibling
note [`05-event-store-query-transport.md`](05-event-store-query-transport.md).

## 1. What the event store knew and could not say

Since the `#` firehose binding landed
([ADR-035](../../adr/035-event-store-firehose-topic-exchange.md)), the service has captured a
copy of **every** business event any of the five other services publishes, plus the
cross-cutting staff audit stream. Two tables in the isolated `ris_eventstore` schema
([ADR-034](../../adr/034-isolated-eventstore-database.md)) have been filling ever since.

Both repository ports exposed exactly one method — `append` — and the service had no
`presentation/` layer at all. The only thing in this repository that ever read those tables
back was a test's raw SQL. An operator with a question had a MySQL client and nothing else.

That is a strange thing for an audit capability to be. An audit log that cannot be
interrogated is a liability rather than a control: it costs storage, it accepts writes on the
hot path's behalf, and it repays nothing. Worse, `audit:read` had existed as a permission code
— and been seeded onto the `admin` role — since the RBAC work, gating a capability that did
not exist.

The gap was deliberate rather than accidental. ADR-034 called querying "a later, low-frequency
capability," and two speculative read methods that once sat on the ports
(`listByCorrelationId` on the firehose port, `listByActor` on the audit port) were deleted
unwired, because their shapes were wrong for the surface actually needed: newest-first,
unbounded, unfiltered. This note builds the surface from scratch rather than resurrecting
them.

## 2. Two logs, two questions

The event store keeps its two logs in two tables, and the reason is not tidiness.

| Table | Question it answers | Row source |
| --- | --- | --- |
| `domain_event` | *What did the system do?* | every routing key on `ris.events` except `audit.staff.action` |
| `audit_log_entry` | *What did a person do?* | the `audit.staff.action` stream only |

They have different subjects. A `domain_event` row is a copy of a message: it names a
producer, an aggregate, and an opaque payload, and nobody is accountable for it. An
`audit_log_entry` row names an **actor** — a staff principal, or the `system` origin class for
everything else — and a resource that actor mutated, with `before` / `after` snapshots. You
filter the first by *what kind of thing happened*; you filter the second by *who did it and to
what*.

So they get two filter sets, not one generalized one:

| `domain_event` | `audit_log_entry` |
| --- | --- |
| `eventType` (the full dotted routing key) | `actorId` |
| `aggregateType` (the key's second token) | `entityType` |
| `aggregateId` | `entityId` |
| — | `action` (the event-name classifier) |
| `correlationId` | `correlationId` |
| `from` / `to` (inclusive `occurred_at`) | `from` / `to` (inclusive `occurred_at`) |

Every field is optional. An absent filter contributes **no predicate**, so an empty filter set
reads the whole log; a supplied one narrows it. Both reads are newest-first
(`occurred_at DESC, id DESC`) because the operator's unstated default question is "what just
happened."

Neither read is cached. The reasoning is the same one the `stock_movement` audit ledger
records: an operator-driven query is low-frequency and wants the *latest* rows, so a cache
would buy no hit rate while adding an invalidation hop to the system's highest-volume write
stream.

## 3. The filter sets and the indexes that serve them

Every filter names an indexed column. No index was added for this work — read the two
migrations under [`migrations/eventstore/`](../../../migrations/eventstore/) and you will find
all seven already there, created alongside the tables.

**`domain_event`** — one UNIQUE (the ingest dedupe anchor) and three secondary indexes:

| Filter combination | Index that serves it |
| --- | --- |
| `aggregateType` + `aggregateId` (+ time window) | `IDX_DOMAIN_EVENT_AGGREGATE (aggregate_type, aggregate_id, occurred_at DESC)` |
| `eventType` (+ time window) | `IDX_DOMAIN_EVENT_TYPE (event_type, occurred_at DESC)` |
| `correlationId` | `IDX_DOMAIN_EVENT_CORRELATION (correlation_id)` |
| no filter, or a time window alone | none — an `occurred_at DESC` scan |

**`audit_log_entry`** — no UNIQUE (audit has no dedupe key) and four secondary indexes:

| Filter combination | Index that serves it |
| --- | --- |
| `actorId` (+ time window) | `IDX_AUDIT_LOG_ENTRY_ACTOR (actor_id, occurred_at DESC)` |
| `entityType` + `entityId` (+ time window) | `IDX_AUDIT_LOG_ENTRY_ENTITY (entity_type, entity_id, occurred_at DESC)` |
| `action` (+ time window) | `IDX_AUDIT_LOG_ENTRY_ACTION (action, occurred_at DESC)` |
| `correlationId` | `IDX_AUDIT_LOG_ENTRY_CORRELATION (correlation_id)` |

The trailing `occurred_at DESC` on the first three of each set is not decoration: it is a
MySQL 8 descending index, and it is why the newest-first sort is served straight from the
index rather than by a filesort. The `id DESC` tiebreaker after it makes the order *total*, so
a page boundary between two rows sharing a millisecond neither drops a row nor repeats one.

Note the shape this implies: the aggregate and entity indexes have `aggregate_type` /
`entity_type` as their **leading** column, so filtering by `aggregateId` alone (without
`aggregateType`) uses no index. That is a real limitation and an acceptable one — an aggregate
id is only meaningful alongside its type, since ids are not unique across aggregate kinds.

## 4. Why the filters touch indexed columns only

`domain_event.payload`, `audit_log_entry.before`, and `audit_log_entry.after` are JSON
columns. All three are **returned** by the reads. None of them is **searchable**.

The alternative would be a `LIKE '%…%'` or a `JSON_EXTRACT(payload, '$.orderId') = ?`
predicate. Neither can use an index. On an ordinary table that costs a scan; on this one it
costs a scan of the largest and fastest-growing table in the system — the one ADR-034
isolated into its own schema *precisely because* its append load must never pressure anything
else. A query surface that made a full scan one query parameter away would hand any operator a
loaded weapon, and would do it on the table where the weapon does the most damage.

Deep-paging the same table is also a scan-shaped cost (§5), but it is bounded by how far a
human is willing to page. A `JSON_EXTRACT` filter is unbounded on every single request.

If event-body search is ever genuinely needed, it belongs in a purpose-built index — a
generated column with its own index, or a search engine fed from the log — not in a `WHERE`
clause over the write path's storage.

## 5. Pagination

Both queries take an optional 1-based `page` and an optional `pageSize`, and normalize them
through one call:

```ts
const { page, size } = clampPageWindow(payload.page, payload.pageSize, {
  defaultPage: 1,
  defaultSize: 20,
  maxSize: 100,
});
```

`clampPageWindow` (`@retail-inventory-system/common`) floors before it checks positivity, so a
fractional page in `(0, 1)` — which would pass a naive `> 0` guard and then floor to `0`,
turning `skip((page - 1) * size)` into a **negative offset** — collapses to the default
instead. `pageSize` is floored, defaulted to 20, and capped at 100.

**That call is the entire "max page size 100" rule, and it lives in the use case.** It is
deliberately *not* also expressed as a `@Max(100)` on the gateway DTO. An RMQ handler is
directly reachable: anything holding a `ClientProxy` onto the queue can send
`{ pageSize: 100000 }` without ever passing through the gateway. Putting the cap where the
query is built means every caller inherits it — today's gateway, tomorrow's operator script,
and any future caller nobody has thought of. A DTO-side copy would be a second source of truth
that drifts the first time the cap is retuned.

"Directly reachable" is an argument about the *whole payload*, not just its page window, and
each use case defends `filters` for the same reason it clamps `page`: `payload.filters ?? {}`.
An omitted filter set means the widest predicate — the whole log — and must not reach
`repository.query(undefined, …)`, whose first line dereferences it. The trace guards its
`targetCorrelationId` on the same principle and for a sharper reason (see
[ADR-039](../../adr/039-audit-and-event-store-query-surface.md) §6): TypeORM drops an
`undefined` from a `where` clause rather than matching nothing, turning an unguarded read into
an unbounded scan.

The response is the canonical `IPage<T>` envelope: `{ items, total, page, size }`. Note the
asymmetry between request and response — the wire **asks** for `pageSize` and the page
**answers** with `size`. That is not an oversight; it is the shape `inventory.stock-movement.list`
and `notification.delivery.list` already use, and inventing a `{ rows, pageSize }` response
here would have made the event store the odd one out.

`total` is the full-match count (`findAndCount` issues the `COUNT(*)` alongside the page
`SELECT`), so a client can compute the page count without probing.

## 6. The trace, and why it is not paginated

`TraceByCorrelationUseCase` answers a different shape of question: *everything that one
request caused, across every service that touched it.*

It takes a `targetCorrelationId` and returns two arrays:

```ts
{ events: DomainEventView[], auditEntries: AuditLogEntryView[] }
```

Three properties distinguish it from the two queries.

**It is unpaginated.** A correlation id scopes exactly one request's causal chain. That chain
is bounded by what one request can do, and in this system that is a handful of events and at
most a few audit rows. There is nothing to page, and paginating would force the caller to
reassemble a timeline from fragments.

**It is ascending** — `occurred_at ASC, id ASC` on both reads. A trace is a timeline, and a
timeline reads forward. This is the direct opposite of the two queries' newest-first order,
and it is the concrete reason the deleted `listByCorrelationId` (which sorted newest-first)
could not simply be kept: the two reads would have overlapped and disagreed.

**It returns two arrays, not one merged stream.** The two logs answer different questions and
their `id` spaces are unrelated; interleaving them by timestamp would suggest a causal
ordering between an event and an audit row that the timestamps do not actually establish. The
two reads touch different tables, so they are issued concurrently with `Promise.all`.

**An unknown correlation id yields `{ events: [], auditEntries: [] }`, never a `404`.** The
absence of a trace is not the absence of a resource: the id may name a request that emitted
nothing, or one whose events have not been ingested yet (the firehose is at-least-once and
asynchronous). A `404` would assert that the id itself is invalid, which the event store has
no way to know.

## 7. The cross-module read

`TraceByCorrelationUseCase` lives in the `audit-log/` module. It needs `domain_event` rows.
The `domain-events/` module owns that table.

`eslint-plugin-boundaries` ([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md))
forbids the reach: a module's `application/use-cases` may inject only its own module's ports,
and `yarn lint` is the source of truth for where a file belongs. The rule was not weakened.

Instead the trace reaches the table through **`TRACE_DOMAIN_EVENT_READER`**, a
raw-parameterized-SQL reader port. Its adapter issues one statement through the injected
`EntityManager`:

```sql
SELECT id, event_type, …, occurred_at
  FROM domain_event
 WHERE correlation_id = ?
 ORDER BY occurred_at ASC, id ASC
```

The `?` is bound by the driver, never string-concatenated. The port returns a plain row shape
(`ITraceDomainEventRow`), deliberately **not** the sibling module's `DomainEvent` model:
leaking that class through the seam would re-couple by *type* exactly what the boundary
decoupled by *import*. The use case projects the row onto the wire view itself, duplicating a
few lines of field copying — the same trade the returns module makes with its local copy of
`retry-then-log-for-replay.ts`.

This is not a new invention. It is the seam this codebase already uses three times:

- **`ORDER_CART_READER`** — the retail `orders` module reading the `cart` tables its sibling
  `cart` module owns.
- **`RETURN_ORDER_READER`** — the retail `returns` module reading the `order` / `order_line` /
  `fulfillment` tables the `orders` module owns.
- **`CONSENT_READER`** — the notification service reading the gateway-owned `consent_record`.

The event store's case is the easiest of the four: both modules live in the same
`ris_eventstore` schema on the same connection, so no join is lost and no second connection is
opened. Only the module line is crossed, and it is crossed through a port.

## 8. Two column asymmetries worth knowing

The two `correlation_id` columns look alike and are not.

**`domain_event.correlation_id` is `NOT NULL DEFAULT ''`.** MySQL treats `NULL`s as *distinct*
inside a UNIQUE index, so a nullable column would have silently defeated the ingest dedupe key
`(producer, event_type, aggregate_id, occurred_at, correlation_id)` on every redelivery of an
event that carried no correlation id — the log would accumulate a duplicate row per redelivery,
which is precisely what at-least-once delivery guarantees will happen.

The consequence for a query: an event ingested without a correlation id stored `''`. It
matches no trace and no `correlationId` filter a caller can meaningfully pass, and the view
reports it honestly as `''` rather than rewriting it to `null`. The gateway DTO rejects an
empty `targetCorrelationId` so nobody asks for that bucket by accident.

**`audit_log_entry.correlation_id` is nullable.** The audit trail has no dedupe key — two
identical staff actions a second apart are two real events — so nothing forced the column
non-null. A `WHERE correlation_id = ?` therefore never matches a null-correlation row. That is
correct: such a row belongs to no request's causal chain, and it is still reachable by
`actorId`, `action`, or `entityType` + `entityId`.

## 9. Inverted ranges, and the exception type that does not exist

`from` and `to` bound `occurred_at` inclusively. Both bounds present becomes `BETWEEN`; one
bound becomes a single comparison; neither becomes no predicate at all. An **unparseable** ISO
string is treated as absent rather than rejected — the gateway DTO's `@IsISO8601()` is the
validation gate, so a malformed bound can only arrive over a direct RPC, where widening the
scan is the safe answer.

What about `from > to`?

`Between(hi, lo)` compiles to `BETWEEN hi AND lo`, which MySQL evaluates to the empty set.
**The queries return an empty page.** They do not reject.

The alternative was a `400`-mapped rejection from the use case — and that is not a small
change. The event store has **no domain exception type**: no `*DomainException`, no
`*ErrorCodeEnum`, no `*RpcExceptionFilter`. Its two domain models throw plain `Error`s,
justified as internal caller bugs. Introducing the triple would mean three new files whose
entire purpose is one message about one degenerate input — and would establish an error-mapping
surface that the next contributor would then feel obliged to extend.

An empty window containing no instants honestly contains no rows. Shape errors (a non-ISO
string, an empty `targetCorrelationId`, a negative page) belong where every other shape error
in this system already lives: the gateway DTO. So the event store keeps its
`*RpcExceptionFilter`-shaped hole, deliberately.

The same rule applies to both queries, so there is exactly one behaviour to remember.

## 10. Related reading

- [`05-event-store-query-transport.md`](05-event-store-query-transport.md) — the
  `event_store_query_queue` RPC transport that exposes these three use cases, and the hybrid
  boot that connects it beside the firehose.
- [ADR-039](../../adr/039-audit-and-event-store-query-surface.md) — the decision record for the
  whole query capability: the two queries, the trace, the dedicated RPC queue, the gateway
  proxy, and the alternatives each lost to.
- [ADR-034](../../adr/034-isolated-eventstore-database.md) — why `ris_eventstore` is a separate
  logical database, and why its growth profile is the argument against a full scan.
- [ADR-035](../../adr/035-event-store-firehose-topic-exchange.md) — the `ris.events` topic
  exchange and the `#` firehose that fills both tables.
- [ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md) — the cross-module
  isolation the trace's reader port respects rather than weakens.
- [`../11-event-store-and-audit-log/06-append-only-enforcement.md`](../11-event-store-and-audit-log/06-append-only-enforcement.md)
  — why the two repositories implement their ports directly, and why adding reads does not
  weaken that.
- [`../11-event-store-and-audit-log/03-domainevent-ingestion-and-idempotency.md`](../11-event-store-and-audit-log/03-domainevent-ingestion-and-idempotency.md)
  — the ingest path that fills `domain_event`, and the `correlation_id` coalescing §8 explains.
