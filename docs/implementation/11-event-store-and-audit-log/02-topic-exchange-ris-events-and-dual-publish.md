# The `ris.events` topic exchange and producer dual-publish

This document introduces the messaging topology that lets the event-store
microservice capture **every** business event the system produces, and wires the
**first producer** onto it. It builds directly on the idle event-store shell from
[01-new-event-store-microservice-scaffold.md](01-new-event-store-microservice-scaffold.md)
and records the decision formalized in
[ADR-035](../../adr/035-event-store-firehose-topic-exchange.md).

The audit-publisher swap that rides this topology — the `IAuditLogEvent →
IAuditStaffActionEvent` mapping and the deletion of the log-only no-ops — is
documented separately in
[04-auditlog-ingestion-and-publisher-swap.md](04-auditlog-ingestion-and-publisher-swap.md).

## 1. The problem: fan-out without destabilizing the bus

The event store must persist an append-only copy of every event published anywhere
in the system. But the existing RabbitMQ topology
([ADR-008](../../adr/008-rabbitmq-via-libs-messaging.md),
[ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)) is built for **point-to-point**
delivery, not fan-out:

- one queue per service (`retail_queue`, `inventory_queue`, `notification_events`,
  `catalog_queue`), every queue bound to the **default exchange**;
- the producer-targets-consumer-queue pattern — a producer emits an event onto the
  *consumer's* queue (e.g. `retail.order.placed` lands on `notification_events`);
- the same `ClientProxy.send` / `@MessagePattern` mechanism also carries **RPC**
  request/response traffic, which depends on direct-queue routing.

There is no single place to subscribe to "all events." Worse, the obvious move —
re-pointing every consumer queue at a shared exchange — would touch every consumer in
the system and put the RPC paths at risk. Both ADR-008 and ADR-020 anticipated this and
left an explicit reservation: the `EXCHANGES` constants are reserved "for future
topic-exchange routing — don't add per-exchange wiring without a follow-up ADR," and
"all queues bind to the default exchange today — don't wire topic exchanges without a
follow-up ADR." Capturing the firehose is precisely the change those notes guarded, so
it required ADR-035 first.

## 2. The decision: a topic exchange + producer dual-publish

The system gains **one** new durable exchange, `ris.events`, of type **topic** (the
constant `EXCHANGES.RIS_EVENTS_TOPIC` in
[`libs/messaging/exchanges.constants.ts`](../../../libs/messaging/exchanges.constants.ts)
— `EXCHANGES`' first *live* member; `RETAIL`/`INVENTORY`/`NOTIFICATION` stay reserved
placeholders).

Producers reach it by **dual-publish**: a producer keeps its existing default-exchange
`emit` to its current destination **and** mirrors the *same routing key + payload* onto
`ris.events`. The mirror is the only new behavior — the original emit, and every
existing consumer, are untouched.

```
                       ┌────────────────────────► notification_events (unchanged)
  producer ──emit──────┤   (existing default-exchange destination)
                       │
                       └──mirror──► ris.events (topic) ──#.#──► event_store_firehose_queue
```

**Why dual-publish and not consumer re-binding?** Re-binding every existing consumer
queue to `ris.events` would touch every consumer and risk the RPC request/response paths
that rely on direct-queue routing — a large, fragile change for no benefit dual-publish
does not already deliver. Dual-publish is purely additive: a queue that wants an event
keeps receiving it exactly as before, and the event store receives a *copy* through a
separate channel. The cost is one extra publish per mirrored event, which is acceptable
for a best-effort, post-commit fan-out.

**Delivery semantics.** Publishing onto `ris.events` is best-effort post-commit
([ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)): there is no transactional
outbox. A failed mirror is warn-logged and swallowed, never rethrown — a dropped mirror
must never block the mutation that already committed. At-least-once on the broker plus an
idempotent consumer (a later capability) absorbs duplicate delivery.

## 3. One firehose queue with in-consumer dispatch

The event store will bind **one** queue, `event_store_firehose_queue`, to `ris.events`
with routing key `#.#` (every event), and dispatch by the concrete routing key **inside
the consumer**: `audit.staff.action` to the audit-log ingest, everything else to the
domain-event ingest.

This refines the earlier "two queues" sketch (a dedicated audit queue beside a
domain-event queue). A single Nest application binds every `@EventPattern` to **every**
connected RMQ transport, so two queues with disjoint pattern sets in one app is not
cleanly supported. One `#.#` queue plus an in-consumer routing-key switch keeps all
ingestion in one place and sidesteps that limitation. (The consumer that realizes this is
a later capability; the topology it binds to is fixed here.)

## 4. The shared mirror utility and the topic-exchange client

Two new pieces in [`libs/messaging`](../../../libs/messaging) carry the producer side:

- **`MicroserviceClientRisEventsModule`**
  ([`microservice-client-ris-events.module.ts`](../../../libs/messaging/microservice-client-ris-events.module.ts))
  registers a `ClientProxy` under the new token
  `MicroserviceClientTokenEnum.RIS_EVENTS_PUBLISHER`, configured for the topic exchange:

  ```ts
  {
    transport: Transport.RMQ,
    options: {
      urls: [RABBITMQ_URL],
      exchange: 'ris.events',
      exchangeType: 'topic',
      wildcards: true,
      queueOptions: { durable: true },
    },
  }
  ```

  With `wildcards: true` and a named `exchange`, `emit(routingKey, payload)` publishes to
  `ris.events` using `routingKey` as the AMQP **topic routing key** — instead of the
  default-exchange behavior of publishing onto a queue named after the pattern. No queue
  is asserted on the producer side. The module exports both the `ClientsModule` (so
  adapters can inject the client directly) and the mirror publisher below.

- **`RisEventsMirrorPublisher`**
  ([`ris-events-mirror.publisher.ts`](../../../libs/messaging/ris-events-mirror.publisher.ts))
  is the **single** place the mirror `emit` boilerplate lives. It injects the
  `RIS_EVENTS_PUBLISHER` client and exposes one method,
  `mirror(routingKey, payload)`, which `await firstValueFrom(client.emit(routingKey,
  payload))`. The domain-event publishers reuse this helper for the bulk fan-out (a later
  capability); nothing else should hand-roll a second mirror emitter.

A new routing key, `ROUTING_KEYS.AUDIT_STAFF_ACTION = 'audit.staff.action'`
([`routing-keys.constants.ts`](../../../libs/messaging/routing-keys.constants.ts)),
names the first stream to ride the exchange. It is the cross-cutting staff-action audit
stream, consumed only by the event store's audit-log ingest. The legacy
`MicroserviceMessagePatternEnum` mirror is intentionally **not** extended for it — that
enum is a back-compat surface only, and a brand-new event has no prior consumer to keep
compatible.

## 5. The audit publisher: the first producer onto `ris.events`

Rather than wire the bulk domain-event fan-out immediately, the topology is proven
end-to-end by its smallest real producer: the `AUDIT_LOG_PUBLISHER` seam. Until now both
of its bindings — the api-gateway `auth` module and the retail `orders` module, the
**only two** audit call sites in the system — used a log-only `NoOpAuditLogPublisher`.
They now bind a real `RmqAuditLogPublisher` that maps the in-process audit event to the
`audit.staff.action` wire shape and emits it onto `ris.events`.

A live check confirms the path: a real staff login (`POST /api/auth/staff/login`)
publishes one message to `ris.events` with routing key `audit.staff.action`, which a
temporary `#.#`-bound probe queue receives — proving api-gateway → topic exchange →
firehose-shaped binding works before any consumer exists. The mapping, the no-op
deletions, and why only these two services are swapped are detailed in
[04-auditlog-ingestion-and-publisher-swap.md](04-auditlog-ingestion-and-publisher-swap.md).

## What is deliberately deferred

This change wires the producer side and one producer. Later capabilities complete the
picture:

- **The bulk dual-publish fan-out** — mirroring the seven domain-event publishers
  (`catalog.*`, `inventory.*`, `retail.*`, notification events) onto `ris.events` through
  `RisEventsMirrorPublisher`.
- **The firehose consumer** — the `#.#` binding on the event-store listener, the
  in-consumer routing-key dispatch, the ingest use cases, and the duplicate-absorbing
  idempotency key.
- **The persistence** — the `domain_event` / `audit_log_entry` tables in
  `ris_eventstore`.
