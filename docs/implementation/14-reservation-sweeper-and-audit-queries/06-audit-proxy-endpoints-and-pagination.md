# Putting the audit log behind HTTP

The event store answers three RPCs, and until now nothing asked them. This note describes the
API gateway module that does — `apps/api-gateway/src/modules/audit/`, three `GET` routes under
`/api/audit`, gated by `audit:read`.

It is the gateway's tenth RPC-fronting module and follows the shape of the nine before it
exactly: an `application/ports` seam, thin `application/use-cases`, one
`infrastructure/messaging` adapter holding the only `ClientProxy`, a `presentation/`
controller, and **no `domain/`** — the gateway holds no audit state
([ADR-009](../../adr/009-port-adapter-at-the-gateway.md)). The transport it speaks to was built
in the sibling note [`05-event-store-query-transport.md`](05-event-store-query-transport.md);
the use cases behind it in [`04-audit-query-read-seams-and-indexes.md`](04-audit-query-read-seams-and-indexes.md).

## 1. What an operator can now ask

Three questions, in the language an operator actually uses, each mapped to one route:

| The question | The route |
| --- | --- |
| *"What happened to order 42?"* | `GET /api/audit/events?aggregateType=order&aggregateId=42` |
| *"What has this staff member been doing?"* | `GET /api/audit/entries?actorId=<uuid>` |
| *"Show me everything that one request touched."* | `GET /api/audit/trace/<correlationId>` |

Before this, the answer to all three was *"open a MySQL client and query `ris_eventstore`."* An
audit log that cannot be interrogated is a liability, not a control.

The three are not interchangeable, and the difference is worth internalising:

- **`/audit/events`** reads `domain_event` — the firehose copy of every business event the
  system publishes. It answers *what the system did*.
- **`/audit/entries`** reads `audit_log_entry` — the staff action trail fed by the
  `audit.staff.action` stream. It answers *what a person did*.
- **`/audit/trace/:correlationId`** reads **both**, filtered to one correlation id, and returns
  them as two separate arrays. It answers *what one request caused*, end to end.

The `aggregateType` filter is narrower than it looks, and this is the most common way to be
surprised by an empty page. `aggregateType` is the routing key's **second token**, extracted at
ingest: `retail.order.placed` yields `order`, but `retail.payment.authorized` yields `payment`
and `inventory.stock.allocated` yields `stock`. So `?aggregateType=order&aggregateId=42` matches
only `retail.order.placed` and `retail.order.cancelled` — the payment, fulfillment, refund and
stock events that same order produced live under their own aggregate types, keyed by their own
ids. To follow one order *across* aggregates, filter by correlation id, or trace it.

## 2. The routes

Every route is a `GET`, carries `@RequiresPermission(PermissionCodeEnum.AUDIT_READ)`, and lives
on `AuditController` (`@Controller('audit')`, behind the gateway's global `api` prefix).

| Method | Path | Query / params | Auth | Response |
| --- | --- | --- | --- | --- |
| `GET` | `/api/audit/events` | `eventType`, `aggregateType`, `aggregateId`, `correlationId`, `from`, `to`, `page`, `pageSize` | bearer + `audit:read` | `IPage<DomainEventView>` |
| `GET` | `/api/audit/entries` | `actorId`, `entityType`, `entityId`, `action`, `correlationId`, `from`, `to`, `page`, `pageSize` | bearer + `audit:read` | `IPage<AuditLogEntryView>` |
| `GET` | `/api/audit/trace/:correlationId` | — | bearer + `audit:read` | `{ events, auditEntries }` |

Every query parameter is optional and **narrows** the scan; an absent filter contributes no
predicate, so a bare `GET /api/audit/events` lists the whole log, newest first. Every filter
names an **indexed** column. The JSON bodies (`DomainEventView.payload`,
`AuditLogEntryView.before` / `.after`) are *returned* verbatim but never *searched*: a `LIKE` or
`JSON_EXTRACT` predicate over an ever-growing append-only table degrades into a full scan, which
is the one query shape this schema must never make easy
([ADR-039](../../adr/039-audit-and-event-store-query-surface.md)).

The trace is deliberately **unpaginated and ascending**. A correlation id scopes exactly one
request's causal chain, so the result set is bounded and small; and a timeline reads forward,
the opposite of what a "what just happened" list wants. Its two arrays are never merged into one
interleaved stream — they answer different questions and their ids live in different spaces.

## 3. Why `audit:read`, and why nothing else

`audit:read` already existed as a `PermissionCodeEnum` member and was already seeded onto the
`admin` role. It was minted with the RBAC v2 work, before anything could be read with it. This
is the first capability that gates on it, and no `PERMISSION_SEEDS` entry changed.

There is **no owner-check and no customer path**, and that is a structural fact rather than a
scoping decision. A customer JWT carries no `permissions` claim at all
([ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md)), so
`@RequiresPermission(<code>)` is staff-only *by construction* — `PermissionsGuard` cannot pass a
customer token no matter what code it names. Elsewhere in this system a permission code is a
**staff override over an owner-check** (a support agent reading someone else's order). Here
there is nothing to override: an audit log has no owner. There is therefore no customer-facing
audit route to design, and a hypothetical "show me my own events" endpoint would be a different
capability with a different authorization model, not a variant of this one.

`admin` holds `audit:read`; `warehouse-staff`, `catalog-manager` and `order-support` do not. A
token from any of those three gets a `403` from `PermissionsGuard` before a single RPC is sent.

## 4. Where validation lives, and where the cap lives

These two live in different places on purpose.

**Shape validation lives in the gateway DTO.** `EventsQueryDto` and `EntriesQueryDto` enforce:

- `@IsOptional()` on every filter — absence is the wide default.
- `@IsString() @IsNotEmpty()` on every string filter. An empty-string filter is a client bug,
  and on `domain_event` it is a *dangerous* one: `correlation_id` is `NOT NULL DEFAULT ''`, so
  `?correlationId=` would silently match every row ingested **without** a correlation id rather
  than none.
- `@IsISO8601()` on `from` / `to`, plus a cross-property `@IsOnOrAfter('from')` on `to`.
- `@Type(() => Number) @IsInt() @Min(1)` on `page` / `pageSize`.

The `from <= to` check earns its place. The event store answers an inverted window with an
**empty page**, not a rejection — `BETWEEN hi AND lo` selects nothing in MySQL, and growing the
event store its first `*DomainException` + `*ErrorCodeEnum` + `*RpcExceptionFilter` triple for
the sake of one message was not worth it (ADR-039). Without a gateway-side guard, an operator
who transposed two dates would read the empty page as *"nothing happened"*. So the rejection
lives at the HTTP edge, where every other shape error in this system already lives. The
constraint is a small `registerDecorator` in
`presentation/dto/is-on-or-after.validator.ts`; class-validator ships no comparison across two
properties of the same object. It passes whenever the comparison is not meaningful — either
bound absent, or either value unparseable — so one bad value yields one error message rather
than two.

`:correlationId` is a path param, not a DTO field. A bare `/api/audit/trace/` matches no route
(Nest answers `404`), but a whitespace-only segment reaches the handler, and the controller
rejects it with a `400` for the `NOT NULL DEFAULT ''` reason above.

**The page-size ceiling lives in the event store.** `clampPageWindow(page, pageSize,
{ defaultPage: 1, defaultSize: 20, maxSize: 100 })`, inside `QueryDomainEventsUseCase` and
`QueryAuditLogEntriesUseCase`. There is **no `@Max(100)`** on either gateway DTO, and no default
applied at the controller edge either — `page` and `pageSize` are forwarded verbatim,
`undefined` included.

The reason is that an RMQ handler is directly reachable. Anything holding a `ClientProxy` onto
`event_store_query_queue` can send `{ pageSize: 100000 }` without ever passing through the
gateway. Putting the cap where the query is *built* means every caller inherits it: today's
gateway, tomorrow's operator script, and any caller nobody has thought of. A DTO-side copy would
be a second number expressing the same rule, and it would drift the first time the cap is
retuned. Splitting them this way keeps exactly one number in exactly one place.

This is the mirror image of the same call made one route over. `MovementsQueryDto` **does**
carry `@Max(100)`, because `inventory.stock-movement.list` does *not* cap in its use case; the
gateway DTO is the only guard there. In both cases the rule lives in exactly one file. What
matters is that it is never in two.

## 5. The `pageSize` → `size` asymmetry

The request asks for `pageSize`. The page answers with `size`:

```jsonc
// GET /api/audit/events?pageSize=50
{ "items": [ /* … */ ], "total": 651, "page": 1, "size": 50 }
```

That is the canonical `IPage<T>` envelope (`libs/common`), and the asymmetry is inherited rather
than invented: `GET /api/inventory/variants/:variantId/movements` and
`GET /api/notifications/deliveries` already behave this way. `IPage<T>` is the shared response
type for every paginated read in the system, and its length field is `size`; the *query string*
convention for asking is `pageSize`. Matching the existing pair was strictly better than
inventing a third shape — a reader who has seen one paginated route in this codebase already
knows what this one returns.

Ask for `pageSize=500` and you get `size: 100` — verified against the live event store, through
the wire, not just in-process.

## 6. Empty is not missing

No route in this controller ever returns a `404`.

- `GET /api/audit/trace/<unknown>` → `200 { "events": [], "auditEntries": [] }`.
- `GET /api/audit/events?aggregateId=999999` → `200 { "items": [], "total": 0, … }`.

A `404` says *"the resource you named does not exist."* But a correlation id is not a resource —
it is a coordinate in a log. An id with no rows behind it means that request never ran, or ran
before the firehose existed, or ran and produced nothing worth recording. Nothing was deleted
and nothing is missing. Answering `404` would invite a caller to treat *"no history"* as
*"bad id"*, and would make an empty audit trail indistinguishable from a typo.

The same reasoning is why the trace has no existence probe and the two lists have no
`?exists=true`. The zero-row answer *is* the answer.

One asymmetry worth knowing when reading a trace: `auditEntries` may hold more than one copy of
the same action. `audit_log_entry` has no dedupe key, so an at-least-once redelivery of an
`audit.staff.action` message appends a second row. `domain_event` carries the composite UNIQUE
`(producer, event_type, aggregate_id, occurred_at, correlation_id)` and swallows its duplicate
at ingest.

## 7. What an error looks like, and who produced it

Four failures, four different producers. Knowing which is which is most of the debugging.

| Symptom | Produced by | Notes |
| --- | --- | --- |
| `401 Unauthorized` | `JwtAuthGuard`, at the gateway | No bearer token, or an expired one. No RPC is sent. |
| `403 Forbidden` | `PermissionsGuard`, at the gateway | A valid staff token without `audit:read` — or any customer token, which carries no `permissions` claim at all. No RPC is sent. |
| `400 Bad Request` | The `ValidationPipe` over the DTO, at the gateway | A non-ISO `from`, an inverted `from`/`to`, an empty-string filter, `pageSize=0`, an unknown query parameter (the global pipe runs `forbidNonWhitelisted: true`), or a blank `:correlationId`. No RPC is sent. |
| **A request that hangs** | Nobody | `event_store_query_queue` is `durable: true`. With no consumer, the broker *accepts* the RPC message and holds it; the gateway use case awaits `firstValueFrom(client.send(...))` and no reply ever comes. There is no `503`, no connection refused, and no log line at the event store — because the event store is not there to write one. |

That last row is the one that costs an hour. The symptom is a hung HTTP request; the diagnosis
is `rabbitmqctl list_queues name consumers` showing `0` for `event_store_query_queue`. It is
the same failure mode every other RPC in this system has, and no readiness probe covers it
today.

Notably, **the event store itself produces no error**. It has no `*DomainException`, no
`*ErrorCodeEnum` and no `*RpcExceptionFilter`, on purpose: an unknown filter, an unknown
correlation id and an inverted window are all answered with an empty result. So while each use
case wraps its port call in `throwRpcError` — the shared gateway helper that forwards an
upstream `{ statusCode, message, code, details }` verbatim — there is no upstream code for it to
forward. The helper is there for the shape of the module, and for the day the event store grows
one.

## 8. Related reading

- [`04-audit-query-read-seams-and-indexes.md`](04-audit-query-read-seams-and-indexes.md) — the
  three use cases behind these routes: their filters, the indexes that serve them, the
  `clampPageWindow` call that owns the cap, and why an inverted range is an empty page.
- [`05-event-store-query-transport.md`](05-event-store-query-transport.md) — the
  `event_store_query_queue` RPC transport this proxy speaks to, and the hybrid boot that
  connects it beside the firehose.
- [`07-request-libraries-audit-and-sweep.md`](07-request-libraries-audit-and-sweep.md) — the
  Kulala and Posting request files that exercise these routes, and the chaining that carries a
  correlation id from an events query into the trace.
- [ADR-039](../../adr/039-audit-and-event-store-query-surface.md) — the decision record: the two
  queries, the trace, the dedicated RPC queue, this gateway proxy, and the alternatives each
  lost to.
- [ADR-009](../../adr/009-port-adapter-at-the-gateway.md) — the RPC-fronting gateway module
  shape (`no domain/`, one `ClientProxy` in one adapter) this module follows.
- [ADR-024](../../adr/024-rbac-v2-staffuser-customer-and-permissions.md) — `PermissionCodeEnum`
  as the single source of truth, and why a code-gated route is staff-only by construction.
- [ADR-035](../../adr/035-event-store-firehose-topic-exchange.md) — the `ris.events` topic
  exchange that fills `domain_event`, and the `action ← name` mapping the `?action=` filter
  matches against.
