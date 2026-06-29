# Firehose ingestion: capturing every event into `domain_event`

This document covers how the event store actually ingests — how a business event that
crossed the `ris.events` topic exchange becomes a row in the append-only `domain_event`
table, idempotently and crash-safely. It builds on:

- the `ris.events` topology and dual-publish convention in
  [02-topic-exchange-ris-events-and-dual-publish.md](02-topic-exchange-ris-events-and-dual-publish.md);
- the two append-only tables + repositories in
  [06-append-only-enforcement.md](06-append-only-enforcement.md);
- and the decisions in [ADR-035](../../adr/035-event-store-firehose-topic-exchange.md)
  (the firehose exchange + in-consumer dispatch) and
  [ADR-034](../../adr/034-isolated-eventstore-database.md) (the isolated `ris_eventstore`
  schema).

The sibling [04-auditlog-ingestion-and-publisher-swap.md](04-auditlog-ingestion-and-publisher-swap.md)
covers the other branch of the same dispatch — the `audit.staff.action` stream into
`audit_log_entry`.

## 1. One queue, one consumer, in-consumer dispatch

The event store binds a **single** durable queue — `event_store_firehose_queue` — to the
`ris.events` topic exchange with the catch-all binding `#`, so the queue receives
**every** event any producer mirrors onto the firehose. A single `@EventPattern('#')`
handler — the [`FirehoseConsumer`](../../../apps/event-store-microservice/src/modules/firehose.consumer.ts)
— consumes that queue and dispatches each message by its concrete routing key:

- `audit.staff.action` → the audit-log ingest (`audit_log_entry`);
- **everything else** → the domain-event ingest (`domain_event`).

The two logs stay disjoint: an audit action lands **only** in `audit_log_entry`, never
also in `domain_event`.

Why one queue with in-consumer dispatch rather than two queues (one per table)? A single
NestJS microservice application binds **every** `@EventPattern` it declares to **every**
connected transport. Two disjoint pattern sets across two queues is not something the RMQ
strategy supports cleanly — a second queue would receive the same catch-all fan-out and we
would be filtering in code anyway. So the decision (ADR-035) is explicit: one firehose
queue, one consumer, a routing-key switch inside it. The re-bind-every-consumer
alternative was also rejected — it would touch every existing consumer and risk the RPC
`@MessagePattern` paths that depend on direct-queue routing.

### Why the pattern is `#`, not `#.#`

The conceptual binding is "every event". With `wildcards: true`, the `@EventPattern`
string serves **two** roles at once: it is the AMQP binding routing key **and** the
pattern NestJS's own `matchRmqPattern` uses to associate an incoming message with a
handler. Those two layers disagree about `#.#`. RabbitMQ's topic matcher treats `#.#` as
match-everything, so a message *is* delivered to the queue — but Nest's matcher only
accepts `#` as "match all remaining words" when it is the **last** pattern segment. For
`#.#`, the first `#` is not last, so Nest rejects a multi-word routing key like
`audit.staff.action` as an *unsupported event* and nacks it. A lone `#` is the segment-0
*and* last catch-all: it matches any routing key in Nest's matcher and binds as `#` in
AMQP (which also routes every key). So the handler is `@EventPattern('#')`.

### Where the consumer lives, and why

The consumer sits at the **bounded-context root**
(`apps/event-store-microservice/src/modules/firehose.consumer.ts`), beside the
`AuditAndEventsModule` aggregator — **not** inside either sibling module's
`infrastructure/consumers/`. That placement is deliberate and load-bearing:

- The consumer fans out into **both** sibling modules' ingest use cases (`domain-events`
  *and* `audit-log`), so it belongs to neither.
- The architecture's import boundaries ([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md),
  enforced by `eslint-plugin-boundaries`) only let a module's `infrastructure/` inject
  that **same** module's use cases. A cross-module dispatcher physically cannot live in
  one module's `infrastructure/` without violating that rule.
- The context root matches no element-type pattern (exactly like the aggregator module
  itself), so it is the honest home for a concern that spans the whole context. Each
  sibling module **exports** its ingest use case; the aggregator imports both modules and
  registers the consumer, so DI resolves both injections.

The consumer is a thin adapter ([ADR-011](../../adr/011-notifier-port-and-adapters.md)
§4): read the routing key, pick the use case, log. All real logic is in the use cases.

## 2. Reading the *concrete* routing key

`@EventPattern('#')` is a wildcard — it is what binds the queue to the exchange — so
`context.getPattern()` would hand back the literal `'#'`, not the key the producer
actually emitted under. The concrete routing key lives on the raw AMQP message metadata:

```ts
const message = context.getMessage() as { fields: { routingKey: string } };
const routingKey = message.fields.routingKey; // e.g. 'retail.order.placed'
```

That concrete key is both the dispatch discriminator **and** (for domain events) the
stored `event_type`. The amqplib message is loosely typed, so it is cast to the one field
the consumer reads at the transport boundary.

## 3. Heuristic field extraction

A firehose log is a **universal envelope** around an opaque payload — the event store
cannot import any producer's internal event types (cross-service isolation, ADR-017), and
the events carry no uniform `aggregateId` field. So the three indexed columns are
recovered heuristically from what *is* reliable — the dotted routing key and a documented
payload precedence — by the pure helpers in
[`firehose-extractors.ts`](../../../apps/event-store-microservice/src/modules/domain-events/application/use-cases/firehose-extractors.ts):

| Column           | Source                                                                  | Fallback |
| ---------------- | ----------------------------------------------------------------------- | -------- |
| `producer`       | first routing-key token → canonical service name                        | raw token |
| `aggregate_type` | second routing-key token (`retail.order.placed` → `order`)              | `''` |
| `aggregate_id`   | first present of a documented payload key precedence (below)           | `''` |

**Producer mapping.** The first token of `<service>.<aggregate>.<action>` (ADR-008) is
the producing service; it is mapped to the canonical microservice name so the stored
`producer` reads the same as that service's own logs: `inventory` →
`inventory-microservice`, `retail` → `retail-microservice`, `catalog` →
`catalog-microservice`, `notification`/`notifications` → `notification-microservice`. An
unmapped prefix falls back to the raw token (still attributable, just not normalized).

**Aggregate-id precedence** (most specific first), the documented contract the
ingestion and any later read assertion share:

```
aggregateId, id, orderId, variantId, cartId, reservationId, fulfillmentId,
returnRequestId, returnLineId, paymentId, refundId, movementId, deliveryId,
templateId, stockLocationId
```

The first present **scalar** value wins and is stringified — a numeric BIGINT id and a
CHAR(36) UUID both land as text in the `VARCHAR(64)` column. A stray non-scalar under an
id key, or a `null`/`undefined`, is skipped to the next candidate (no useless
`'[object Object]'`). A payload carrying none of these falls back to `''`: the event is
still appended, just not addressable by aggregate id.

Heuristic extraction is the trade-off the universal-envelope design accepts: the firehose
captures everything without coupling to a single producer's schema, at the cost of
best-effort (not guaranteed) aggregate addressing. The columns exist to make the common
case queryable, not to be a foreign key.

## 4. Idempotency: the composite UNIQUE + `correlation_id` coalescing

RabbitMQ is at-least-once ([ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)) and
publishing onto `ris.events` is best-effort post-commit, so the same event can arrive more
than once. The `domain_event` table absorbs that with a composite UNIQUE:

```
UC_DOMAIN_EVENT_IDEMPOTENCY (producer, event_type, aggregate_id, occurred_at, correlation_id)
```

The repository (`DOMAIN_EVENT_REPOSITORY`) swallows the duplicate-key driver error and
reports `{ inserted: false }` instead of throwing, so a redelivery is a silent no-op — no
second row, no exception. The
[`IngestDomainEventUseCase`](../../../apps/event-store-microservice/src/modules/domain-events/application/use-cases/ingest-domain-event.use-case.ts)
logs the two outcomes at `debug`: an insert, or "duplicate dropped — idempotent no-op".

**Why coalesce `correlation_id` to `''`.** The column is nullable (some events genuinely
carry no correlation id), but MySQL treats `NULL` as **distinct from every other NULL** in
a UNIQUE index. If a no-correlation-id event were stored with `correlation_id = NULL`, a
redelivery would compare `NULL != NULL` and slip past the dedupe — a duplicate row on
every retry. So the ingest **coalesces an absent or empty wire `correlationId` to the
empty string `''`** (a real, equal-to-itself value) before appending. The model and
repository pass the value through untouched; the coalescing is the ingest's job because
it is an ingest-time idempotency concern, not a domain invariant.

## 5. Warn-and-drop, never rethrow

A consumer that throws inside an `@EventPattern` makes the broker **blind-redeliver** the
message in a hot loop (ADR-011 §7) — the worst possible failure mode for a firehose. So
the ingest never rethrows. There are two postures:

- **Malformed-input rejection (warn + drop).** `occurred_at` is the producer emit time
  *and* part of the idempotency key, so a missing or unparseable value cannot be defaulted
  without corrupting dedupe. The ingest warn-logs and returns without appending — the
  message is acked. (Re-emitting a corrected event is the producer's responsibility, not
  something the consumer should retry.)
- **Thrown-error swallow.** Any build/JSON/DB error is caught, warn-logged, and swallowed.
  The message is acked; at-least-once delivery plus the idempotency key make a later
  redelivery safe to retry without a duplicate.

The `FirehoseConsumer` wraps the dispatch in its own try/catch as a belt-and-braces
backstop for anything thrown *before* the use case runs (e.g. reading the routing key), so
nothing escapes the handler.

> **`received_at` vs `occurred_at`.** `occurred_at` is the producer's emit time, taken
> from the wire payload; `received_at` is the DB-assigned ingest instant
> (`CURRENT_TIMESTAMP(3)`). Keeping both lets a later read distinguish when an event
> happened from when the store saw it (a redelivery gap, a backlog drain).

## What is deliberately deferred

- **Live domain-event producers.** Today the only live producer on `ris.events` is the
  audit publisher (`audit.staff.action`). The seven domain-event publishers do not mirror
  onto the firehose yet, so the `domain_event` path is exercised by unit tests and a
  manual republish here; its end-to-end proof arrives with the producer dual-publish
  fan-out and the event-store e2e suite.
- **Read / query paths.** `listByCorrelationId` is implemented on the repository so the
  seam is complete, but no HTTP/RPC endpoint is built against it — a cross-service-trace
  query is a later capability.
