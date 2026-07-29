# A second queue: giving the event store a reply path

The event store now answers questions. This note describes the transport that carries them —
a dedicated `event_store_query_queue` on the default exchange, three `audit.*` RPCs, an
ordinary `presentation/` controller, and the hybrid boot that connects two RabbitMQ transports
to one Nest application without ever opening a TCP port.

The three application use cases it exposes were built in the sibling note
[`04-audit-query-read-seams-and-indexes.md`](04-audit-query-read-seams-and-indexes.md), which
deliberately stopped short of a transport. This note is the other half.

## 1. A sink that had to learn to answer

Before this change the event-store microservice was a pure sink. One RabbitMQ transport, one
queue (`event_store_firehose_queue`), bound to the `ris.events` topic exchange with the
catch-all `#` ([ADR-035](../../adr/035-event-store-firehose-topic-exchange.md)). One handler,
`FirehoseConsumer`'s `@EventPattern('#')`. Messages flowed strictly inward: publish, consume,
insert, ack. Nothing ever flowed back out, and nothing could — an `@EventPattern` handler has
no reply path, and the service had no other surface of any kind.

That one queue could not be taught to answer, for a reason that is mechanical rather than
stylistic. It is bound to a topic exchange with `wildcards: true`, and that flag changes how
Nest resolves an incoming message to a handler:

```js
// @nestjs/microservices — server/server-rmq.js
getHandlerByPattern(pattern) {
  if (!this.options.wildcards) {
    return super.getHandlerByPattern(pattern);   // exact Map lookup
  }
  // …otherwise fall through to matchRmqPattern over the wildcard handler map
}
```

With `wildcards` on, resolution is wildcard matching — and the registered pattern `#` matches
*every* routing key by construction. An `audit.event.query` message arriving on that queue
would be matched by `#` as readily as by its own handler, and which one `ServerRMQ` found
first would depend on the order the two controllers happened to be registered in. That is a
correctness property resting on an ordering nobody declares, in a file nobody would think to
look at.

The second, independent objection is about shape. `ris.events` is an **event fan-out**
exchange: producers mirror past-tense facts onto it, best-effort, with no reply and no
expectation that anyone is listening. A query is a **command** with a reply. Putting request
traffic on a fan-out exchange conflates the two, and every future reader has to re-derive that
`audit.event.query` is not an event just because it starts with `audit.`.

So the event store gets a second queue.

## 2. The two transports, side by side

| | `event_store_firehose_queue` | `event_store_query_queue` |
| --- | --- | --- |
| Exchange | `ris.events` (topic) | default (direct) |
| Binding | `#` — every routing key | the queue name, implicitly |
| `wildcards` | `true` | `false` (unset) |
| `noAck` | `false` — manual ack | default (`false`) |
| Handler kind | `@EventPattern` | `@MessagePattern` |
| Direction | one-way ingest | request / reply |
| Who publishes | every producer's `RisEventsMirrorPublisher` mirror | the API gateway's `EVENT_STORE_MICROSERVICE` client |
| Served by | `FirehoseConsumer` | `AuditQueryController` |

Both are ordinary `presentation/` members of the single `audit-and-events` module, registered as
its controllers (`audit-and-events.module.ts`,
`controllers: [FirehoseConsumer, AuditQueryController]`). Each injects use cases that are all
aggregates of that one module, so `presentation/` is exactly where each belongs and
`eslint-plugin-boundaries` ([ADR-017](../../adr/017-architecture-lint-via-eslint-boundaries.md))
— which only lets a module's `infrastructure/` or `presentation/` reach its own module — is
satisfied.

> **Since [ADR-042](../../adr/042-one-bounded-context-one-module.md).**
> [ADR-039](../../adr/039-audit-and-event-store-query-surface.md) originally put both controllers
> at a bespoke **context root** (`modules/` itself, beside `audit-and-events.module.ts`), because
> the event store was then two modules — `domain-events/` and `audit-log/` — and each controller
> injected use cases from *both*, so it could live in neither module's own `presentation/`; the
> context root (which matches no element-type pattern at all) was the honest home for a concern
> spanning the whole context. ADR-042 collapsed the context to one module, dissolving that reason:
> a single module has a single `presentation/`. ADR-039 carries the amendment banner recording
> this.

The three routing keys follow the dotted `<service>.<aggregate>.<action>` shape of
[ADR-008](../../adr/008-rabbitmq-via-libs-messaging.md), and each is a one-line delegation:

| Routing key | Use case | Resolves to |
| --- | --- | --- |
| `audit.event.query` | `QueryDomainEventsUseCase` | `IPage<DomainEventView>` |
| `audit.entry.query` | `QueryAuditLogEntriesUseCase` | `IPage<AuditLogEntryView>` |
| `audit.trace.by-correlation` | `TraceByCorrelationUseCase` | `ICorrelationTraceResult` |

There is **no `*RpcExceptionFilter`** on this controller, and no domain exception for one to
map. That hole is deliberate: an unknown filter value, an unknown correlation id, and an
inverted `from`/`to` window all yield an empty result rather than a rejection, and shape errors
(a non-ISO instant, an empty `targetCorrelationId`) belong to the gateway DTO where every
other shape error in this system already lives. The reasoning is
[ADR-039](../../adr/039-audit-and-event-store-query-surface.md) §1; the consequence is that the
event store remains the one service with no `*DomainException` / `*ErrorCodeEnum` pair.

The controller also carries no logger. `correlationId` is logged **inline** inside each use
case — never through `PinoLogger.assign()`, which throws outside a request scope
([ADR-007](../../adr/007-pino-and-opentelemetry.md) / ADR-011 §7) — which is what every other
RPC controller in this repository does.

## 3. What "one app, every handler on every transport" actually costs here

This is the section to come back to.

A single Nest application registers **every** handler pattern against **every** transport it
connects. There is no per-transport handler scoping. So connecting a second transport to the
app that owns `FirehoseConsumer` and `AuditQueryController` produces two cross-bindings that
were nobody's intent. Both are inert, and each is inert for a different reason.

**Consequence 1 — the firehose queue gains three extra bindings on `ris.events`.**

When `wildcards` is on, `ServerRMQ.listen()` binds every registered handler pattern as an AMQP
routing key:

```js
const routingKeys = Array.from(this.getHandlers().keys());
await Promise.all(routingKeys.map(key => channel.bindQueue(queue, exchange, key)));
```

The handler map now holds four keys — `#`, plus the three `audit.*` ones — so the firehose
queue is bound to `ris.events` four times. This is visible in the RabbitMQ management UI and in
`rabbitmqctl list_bindings`:

```
ris.events   event_store_firehose_queue   #
ris.events   event_store_firehose_queue   audit.event.query
ris.events   event_store_firehose_queue   audit.entry.query
ris.events   event_store_firehose_queue   audit.trace.by-correlation
```

It is inert because **nothing publishes those routing keys to that exchange**. The only
publisher onto `ris.events` is `RisEventsMirrorPublisher` (plus the two real audit-log
adapters), and it mirrors domain events and `audit.staff.action` — never a query command. The
`#` binding already routes every key that *is* published, so the three extra bindings add no
message and change no delivery. Do not "clean them up": they are a direct consequence of the
handler map, and removing them would mean removing the handlers.

**Consequence 2 — the query queue gains an inert `#` handler entry.**

The same handler map means `AuditQueryController`'s three `@MessagePattern`s and
`FirehoseConsumer`'s `@EventPattern('#')` are all registered on the query transport too. Here
`wildcards` is **off**, so `getHandlerByPattern` short-circuits to the base class's exact
`Map.get(pattern)`. The string `'#'` becomes a literal map key that can only be reached by a
message whose pattern is literally `#` — and nothing sends one. An incoming
`audit.event.query` resolves by exact lookup to its own `@MessagePattern` handler, with no
wildcard matching anywhere in the path.

Notice that the two consequences are mirror images, and that the flag which makes each one
harmless is the same flag. This is precisely the distinction
[ADR-039](../../adr/039-audit-and-event-store-query-surface.md) §3 draws against ADR-035's
blanket "two disjoint queues are not cleanly supported." ADR-035's premise is correct and its
decision stands; the failure it named is a **wildcard-matching** failure (a multi-word routing
key that `matchRmqPattern` cannot match under `#.#`, nacked in a hot loop). Neither transport
here is asked to wildcard-match a pattern it does not own. Two disjoint `@EventPattern` sets
across two queues remain unsupported; an event queue plus an RPC queue is supported, and is
what ships. ADR-035 already carries the editorial correction scoping its sentence to event
patterns.

If either consequence ever *does* misbehave, it invalidates that argument and needs a
superseding ADR — not a workaround.

## 4. The hybrid boot

`NestFactory.createMicroservice` returns an `INestMicroservice`. That class has no
`connectMicroservice` method: a microservice application owns exactly one transport, by
construction. There is no option, no second call, no way to extend it. The only shape Nest
offers for two transports is the **hybrid application** — `NestFactory.create`, then
`connectMicroservice` once per transport.

```ts
const app = await NestFactory.create(AppModule, { bufferLogs: true });

app.connectMicroservice<MicroserviceOptions>({ /* firehose  — topic, wildcards, noAck */ }, { inheritAppConfig: true });
app.connectMicroservice<MicroserviceOptions>({ /* query     — default exchange       */ }, { inheritAppConfig: true });

app.useLogger(app.get(Logger));

await app.init();
await app.startAllMicroservices();
```

Three things about that shape are load-bearing.

**`init()`, and never `listen()`.** `NestFactory.create` instantiates an HTTP adapter, but the
adapter binds no TCP port until `app.listen(port)` is called. The event store never calls it —
it has no HTTP surface, and every inter-service hop in this system is RabbitMQ
([ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md)). The proof is direct: with the
service running, `ss -lntp` shows no listener owned by its pid.

**`init()` is what runs the lifecycle, and it must run first.** `connectMicroservice` marks
each `NestMicroservice` as already-initialized and its init hook as already-called:

```js
// @nestjs/core — nest-application.js
instance.registerListeners();
instance.setIsInitialized(true);
instance.setIsInitHookCalled(true);
```

so `startAllMicroservices()` → `msvc.listen()` skips `registerModules()` and therefore skips
`callInitHook()`. Nothing else would ever fire `onModuleInit` / `onApplicationBootstrap` on the
main container. Calling `init()` **before** `startAllMicroservices()` also means the
`ris_eventstore` connection is open before either queue starts delivering — the reverse order
starts consuming into a half-built container.

**The tracer import stays first.** `main.ts`'s first line is
`import '@retail-inventory-system/observability/tracer'`. OpenTelemetry's auto-instrumentation
patches modules at load time, so anything `require()`d before it is invisible to tracing
([ADR-007](../../adr/007-pino-and-opentelemetry.md)). Switching from `createMicroservice` to
`create` changed the lines below it and none above it. Never let a formatter or an
import-sorter hoist something over it.

The firehose transport's options are **byte-for-byte what they were**: same queue, same
`exchange: 'ris.events'`, same `exchangeType: 'topic'`, same `wildcards: true`, same
`noAck: false`, same lone `#`. The query transport's options mirror
`apps/inventory-microservice/src/main.ts` — `queue`, `queueOptions: { durable: true }`, and
nothing else. No `exchange`, no `wildcards`, no `noAck`.

## 5. The `audit.` namespace holds an event and three commands

Four routing keys now begin with `audit.`, and they travel two different paths that never
touch:

| Key | Kind | Exchange | Queue |
| --- | --- | --- | --- |
| `audit.staff.action` | **event** | `ris.events` | `event_store_firehose_queue` |
| `audit.event.query` | command | default | `event_store_query_queue` |
| `audit.entry.query` | command | default | `event_store_query_queue` |
| `audit.trace.by-correlation` | command | default | `event_store_query_queue` |

`audit.staff.action` is emitted by the real `AUDIT_LOG_PUBLISHER` adapters (the gateway's
`auth` module and retail's `orders` module) whenever a privileged actor mutates state; the
`FirehoseConsumer` branches on it and routes it to `IngestAuditLogUseCase` while every other
key goes to `IngestDomainEventUseCase`. The three query keys are sent by the gateway and
answered synchronously. They share a prefix because they share a subject — the audit
capability — and nothing else.

The prefix is also why the three extra `ris.events` bindings look alarming and are not: a key
being *bindable* on an exchange says nothing about anything *publishing* it there.

## 6. Operating it

**Two queues must exist and each must have a consumer.** After the event store boots:

```bash
docker exec rabbitmq rabbitmqctl list_queues name consumers
#   event_store_firehose_queue   1
#   event_store_query_queue      1

docker exec rabbitmq rabbitmqctl list_bindings source_name destination_name routing_key
#                event_store_firehose_queue   event_store_firehose_queue
#                event_store_query_queue      event_store_query_queue
#   ris.events   event_store_firehose_queue   #
#   ris.events   event_store_firehose_queue   audit.event.query
#   ris.events   event_store_firehose_queue   audit.entry.query
#   ris.events   event_store_firehose_queue   audit.trace.by-correlation
```

The first two rows have an **empty** `source_name`: that is how the default exchange prints.

`event_store_query_queue` must appear **only** with that default-exchange binding. A
`ris.events` binding on it would mean the query transport was configured with an `exchange`,
and it would then receive the entire firehose as unroutable RPC traffic.

**A missing consumer on `event_store_query_queue` looks like a timeout, not an error.** Both
queues are `durable: true`, so if the event store is down the broker accepts an RPC message and
holds it. The caller — a gateway use case awaiting `firstValueFrom(client.send(...))` — simply
never receives a reply. There is no `503`, no connection refused, and no log line at the event
store, because the event store is not there to write one. The symptom is a hung request; the
diagnosis is `list_queues name consumers` showing `0`. This is the same failure mode every
other RPC in this system has, and it is why the firehose (`noAck: false`, best-effort,
warn-swallowing) and the queries (request/reply) are worth keeping on separate queues: a
backlog on one never starves the other.

**Nothing is asserted in `docker-compose.yml`.** The queue is declared by the consumer at boot,
like every other queue in this system.

## 7. Related reading

- [ADR-039](../../adr/039-audit-and-event-store-query-surface.md) — the decision this note
  implements: the second queue, the `audit.*` command namespace, the hybrid boot, and the
  refinement of ADR-035 it rests on.
- [ADR-035](../../adr/035-event-store-firehose-topic-exchange.md) — the `ris.events` topic
  exchange, the `#` firehose binding, and the two editorial corrections that scope its
  "two queues" sentence.
- [ADR-034](../../adr/034-isolated-eventstore-database.md) — the isolated `ris_eventstore`
  database the second transport reads.
- [ADR-008](../../adr/008-rabbitmq-via-libs-messaging.md) — the dotted routing-key shape, and
  the producer-targets-the-consumer's-queue rule the gateway client obeys.
- [ADR-020](../../adr/020-rabbitmq-as-inter-service-bus.md) — why the event store gets a second
  queue rather than an HTTP surface.
- [ADR-007](../../adr/007-pino-and-opentelemetry.md) — the first-import tracer rule the hybrid
  boot preserves, and the inline-`correlationId` logging rule the controller follows.
- [`04-audit-query-read-seams-and-indexes.md`](04-audit-query-read-seams-and-indexes.md) — the
  three use cases this transport exposes, their filters, their indexes, and why an inverted
  range is an empty page.
- [`06-audit-proxy-endpoints-and-pagination.md`](06-audit-proxy-endpoints-and-pagination.md) —
  the API gateway module that consumes this transport, and why a missing consumer on
  `event_store_query_queue` reaches an HTTP caller as a hung request rather than an error.
