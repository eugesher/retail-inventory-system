# ADR-035: The `ris.events` topic-exchange firehose and producer dual-publish

- **Date**: 2026-06-27
- **Status**: Accepted

---

## Context

The event-store microservice ([ADR-034](034-isolated-eventstore-database.md)) exists to
be an append-only sink for two streams: the **event firehose** — every business event
published anywhere in the system — and the **staff audit log**. ADR-034 stood the
service up as an idle RMQ listener and explicitly deferred *how* events reach it.

Today the bus is wired the way [ADR-008](008-rabbitmq-via-libs-messaging.md) and
[ADR-020](020-rabbitmq-as-inter-service-bus.md) record it: **one queue per service**,
every queue bound to the **default exchange**, and the producer-targets-consumer-queue
pattern (a producer emits an event onto the *consumer's* queue). Both ADRs left an
explicit reservation: `EXCHANGES` constants exist "for future topic-exchange routing —
don't add per-exchange wiring without a follow-up ADR," and "all queues bind to the
default exchange today — don't wire topic exchanges without a follow-up ADR."

**This ADR is that follow-up.** Capturing *every* event for an append-only log is a
fan-out concern the per-queue default-exchange topology cannot serve: there is no single
place to subscribe to "all events." The question is how to introduce that fan-out
without destabilizing the existing consumers and the RPC request/response paths that
depend on direct-queue routing.

There is also a concrete first producer to wire: the `AUDIT_LOG_PUBLISHER` seam, which
until now bound a log-only no-op in two places (the api-gateway `auth` module and the
retail `orders` module — the only two audit call sites in the system). Swapping that
no-op for a real publisher onto the new exchange proves the topology end-to-end before
the bulk fan-out across the seven domain-event publishers.

## Decision

### A new `ris.events` topic exchange, fed by producer **dual-publish**

Introduce a single durable **topic** exchange, `ris.events` (the constant
`EXCHANGES.RIS_EVENTS_TOPIC`). Producers **dual-publish**: they keep their existing
default-exchange `emit` to its current destination **and** mirror the same routing key +
payload onto `ris.events`. The mirror is the *only* new behavior; the original emit and
every existing consumer are untouched.

The alternative — re-binding every existing consumer queue to `ris.events` — was
rejected because it would touch every consumer and put the RPC (`@MessagePattern`)
request/response paths, which depend on direct-queue routing, at risk. Dual-publish
keeps consumers stable: a queue that wants an event keeps receiving it exactly as before,
and the event store gets a *copy* through a separate channel.

The mirror boilerplate lives in **one** place: a shared `RisEventsMirrorPublisher`
(`libs/messaging`) that injects a topic-exchange `ClientProxy` (registered under
`MicroserviceClientTokenEnum.RIS_EVENTS_PUBLISHER` by `MicroserviceClientRisEventsModule`)
and exposes `mirror(routingKey, payload)`. The client is configured with
`exchange: 'ris.events'`, `exchangeType: 'topic'`, and `wildcards: true`, so
`emit(routingKey, payload)` publishes to the named exchange using `routingKey` as the
AMQP topic routing key. No queue is asserted on the producer side.

### One firehose queue with in-consumer dispatch (not two queues)

The event store binds **one** queue, `event_store_firehose_queue`, to `ris.events` with
routing key `#.#` (every event). A separate `audit.staff.action` queue is **not** used:
a single Nest application binds every `@EventPattern` to every connected RMQ transport,
so two queues with disjoint pattern sets is not cleanly supported. Instead the firehose
consumer reads the concrete routing key off the RMQ message and dispatches
`audit.staff.action` to the audit-log ingest and everything else to the domain-event
ingest. This refines the original two-queue sketch into a single-queue + in-consumer
dispatch shape. (The consumer itself is a later capability; this ADR fixes the topology
it will bind to.)

### A new `audit.staff.action` routing key + wire contract

Add `ROUTING_KEYS.AUDIT_STAFF_ACTION = 'audit.staff.action'` — the cross-cutting
staff-action audit stream — and a wire contract `IAuditStaffActionEvent`
(`libs/contracts/auth`, co-located with the existing `AUDIT_LOG_PUBLISHER` port). The
wire shape is a deliberately **transport-flattened projection** of the in-process
`IAuditLogEvent` so the event store never imports a producer's internal types:

```
action     ← event.name                                   (the stable event-name string)
actorType  ← event.actorKind === 'staff' ? 'staff-user' : 'system'
entityType ← event.targetKind            entityId ← event.targetId
before     ← payload.before ?? null
after      ← payload.after  ?? (whole payload)            (before/after convention)
occurredAt ← (event.occurredAt ?? now).toISOString()
ipAddress  ← null                                          (a documented gap — see below)
eventVersion: 'v1'
```

### The real audit publisher replaces the no-op (cleanup)

Both `AUDIT_LOG_PUBLISHER` bindings — api-gateway `auth` and retail `orders` — swap their
log-only `NoOpAuditLogPublisher` for a real `RmqAuditLogPublisher` that maps
`IAuditLogEvent → IAuditStaffActionEvent` and emits `audit.staff.action` onto
`ris.events`. The two no-op adapter files are **deleted outright** (not renamed). Call
sites are unchanged — they still build the same `IAuditLogEvent`; only the binding moved
from transport-less logging to RMQ. Publishing is **best-effort post-commit** (ADR-020):
a failed emit is warn-logged and swallowed so a broker hiccup never blocks the mutation
that already happened. **No other service gains an audit adapter** — `auth` and `orders`
are the only two audit call sites in the system; an adapter anywhere else would be dead
code.

## Alternatives Considered

- **Re-bind every existing consumer queue to `ris.events`.** Rejected. It touches every
  consumer and risks the RPC request/response paths that rely on direct-queue routing,
  for no benefit dual-publish does not already provide. Dual-publish is additive and
  leaves the operational topology untouched.
- **Two event-store queues (a dedicated `audit.staff.action` queue + a domain-event
  queue).** Rejected. A single Nest app binds every `@EventPattern` to every connected
  transport, so cleanly splitting disjoint pattern sets across two queues in one app is
  not supported. One `#.#` queue + an in-consumer routing-key switch is simpler and
  keeps all ingestion in one place.
- **A transactional outbox for guaranteed delivery.** Rejected for this scope (ADR-020).
  Producers publish best-effort post-commit; at-least-once on the broker side plus an
  idempotent consumer (the ingest idempotency key, a later capability) absorbs duplicate
  delivery without the outbox machinery.

## Consequences

- `EXCHANGES` gains its first **live** member, `RIS_EVENTS_TOPIC: 'ris.events'`;
  `RETAIL`/`INVENTORY`/`NOTIFICATION` stay reserved placeholders. A fifth client token,
  `RIS_EVENTS_PUBLISHER`, and a `MicroserviceClientRisEventsModule` join `libs/messaging`,
  exporting both the topic-exchange `ClientProxy` and the shared `RisEventsMirrorPublisher`.
- The audit log now flows over the wire. A privileged staff action (login, role
  assignment, refund, …) publishes one `audit.staff.action` message onto `ris.events`;
  with the event-store consumer absent it is currently unrouted-and-dropped by the broker
  (best-effort, by design) until the `#.#` firehose binding lands.
- **`ipAddress` is always null.** No call site threads the request IP into the
  `IAuditLogEvent` today; the wire field is present and reserved so the ingest schema is
  stable when IP capture is added.
- The two `no-op-audit-log.publisher.ts` files (and the no-op spec) are gone; the cleanup
  leaves exactly one audit adapter per audited service. The `auth.module.ts`
  `AUDIT_LOG_PUBLISHER` **export** is preserved so the `iam` use cases keep resolving it.
- **Out of scope here** (later capabilities): the dual-publish mirror across the seven
  domain-event publishers; the event-store firehose consumer, its `#.#` binding, the
  ingest use cases, and the duplicate-absorbing idempotency key; the `domain_event` /
  `audit_log_entry` tables. This ADR records only the topology decision and its first
  producer.

## References

- [ADR-034](034-isolated-eventstore-database.md) — the isolated `ris_eventstore`
  database and the idle event-store shell this firehose feeds.
- [ADR-008](008-rabbitmq-via-libs-messaging.md) — dotted routing keys and the
  `EXCHANGES` reservation note; this ADR is the required follow-up before any
  topic-exchange wiring.
- [ADR-020](020-rabbitmq-as-inter-service-bus.md) — one-queue-per-service, default
  exchange, best-effort post-commit publish; the dual-publish here is additive to it.
- [ADR-009](009-port-adapter-at-the-gateway.md) — `ClientProxy` only inside
  `infrastructure/messaging` (and the messaging library); the real audit adapters honor
  it.
- [ADR-032](032-returns-and-refunds-rma-lifecycle-and-restock.md) — the always-audit
  refund money movements that the retail `orders` `RmqAuditLogPublisher` now carries onto
  `ris.events`.
