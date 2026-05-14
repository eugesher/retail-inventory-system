# ADR-020: RabbitMQ as the inter-service message bus

- **Date**: 2026-05-14
- **Status**: Accepted

---

## Context

The API gateway and the three microservices communicate exclusively over
RabbitMQ. The gateway forwards every business request as an RPC to the
owning microservice (`retail.order.create`, `retail.order.confirm`,
`retail.order.get`, `inventory.product-stock.get`); microservices emit
events back into the bus for cross-service consumption
(`retail.order.created`, `retail.order.confirmed`,
`retail.order.cancelled`, `inventory.stock.low`), with the notification
microservice as today's sole event consumer.

This transport choice predates the migration. The codebase uses
`@nestjs/microservices` with the RabbitMQ transport
(`Transport.RMQ`) end-to-end; queues, client modules, and routing keys
live under `libs/messaging`
([ADR-008](008-rabbitmq-via-libs-messaging.md)); the auto-instrumentation
that makes a single trace span all four services
([ADR-014](014-otel-exporter-otlp-http-and-jaeger.md)) hooks the `amqplib`
publish/consume lifecycle to propagate `traceparent` via AMQP message
properties. ADR-008 records the *wiring conventions* (where the modules
live, the dotted routing-key format) but does not record the choice of
RabbitMQ itself; this ADR fills that gap.

The decision matters because every architectural layer downstream takes
RabbitMQ as a load-bearing assumption: the per-module hexagonal layout
(ADR-004) places `@nestjs/microservices` only inside
`infrastructure/messaging/*-rabbitmq.{adapter,publisher}.ts`; the
event-driven notification flow (ADR-011) assumes RMQ `@EventPattern`
subscriptions; the cross-service confirm flow (ADR-013) assumes an RMQ
RPC with `ClientProxy.send()` materialised through `firstValueFrom`; the
boundaries rules (ADR-017) explicitly deny `amqplib` /
`amqp-connection-manager` outside the adapter layer.

---

## Decision

The inter-service transport is **RabbitMQ** for both RPC and
fire-and-forget events.

**Broker.** A single RabbitMQ broker provisioned by `docker-compose.yml`
(`management` image so the web UI is available on
`http://localhost:15672` during local dev). Production may shard or
cluster; the apps connect via a single `RABBITMQ_URL` env var enforced
by the Joi schema in `libs/config`.

**Client library.** `@nestjs/microservices` with `Transport.RMQ`, which
in turn uses `amqplib` via `amqp-connection-manager` (the resilient
reconnecting wrapper). The library is the same on both sides: the
gateway and the microservices speak `ClientProxy` /
`@MessagePattern` / `@EventPattern` — no hand-rolled AMQP code.

**Queues.** One queue per service, defined in
`@retail-inventory-system/contracts/microservices/microservice-queue.enum.ts`:
`retail_queue`, `inventory_queue`, `notification_events`. Each
microservice binds its own queue at startup
(`app.connectMicroservice({ transport: Transport.RMQ, options: { queue }})`).
The gateway and other producers send via the corresponding
`ClientProxy` registered through the
`MicroserviceClient{Retail,Inventory,Notification}Module` modules
exported by `libs/messaging`.

**Messaging patterns.**
- **RPC** (request/response) uses `ClientProxy.send(pattern, payload)`
  and `@MessagePattern(pattern)`. The gateway-side use cases wrap the
  observable in `firstValueFrom` so callers await a plain `Promise`.
- **Events** (fan-out, fire-and-forget) use `ClientProxy.emit(pattern,
  payload)` and `@EventPattern(pattern)`. Publishers materialise the
  emit with `firstValueFrom` as well so async/await semantics are
  uniform across both patterns.

**Routing keys.** Dotted `<service>.<aggregate>.<action>` strings,
defined as `as const` constants in `ROUTING_KEYS` (libs/messaging) and
mirrored in `MicroserviceMessagePatternEnum`
(libs/contracts/microservices). Both names must agree value-for-value;
the contract is asserted by
`libs/messaging/spec/routing-keys.constants.spec.ts`. The naming
convention itself is owned by ADR-008.

**Exchanges.** Today every queue is bound to the **default exchange** —
the `pattern` argument in `@nestjs/microservices` resolves to the
routing key, which the default exchange matches against the queue
name's pattern subscription. The `EXCHANGES` constants in
`libs/messaging` are **reserved** for a future migration to
topic-exchange routing (e.g. `inventory.*.low`, `retail.order.#`); no
adapter binds to them today.

**Correlation and tracing.**
- Every payload extends `ICorrelationPayload` from
  `libs/contracts/microservices`; the `correlationId` is propagated by
  the gateway middleware (ADR-001) and included on every log line
  microservices emit.
- `traceparent` (W3C trace context) is injected into AMQP message
  properties by the OpenTelemetry `amqplib` auto-instrumentation
  (ADR-014). Consumers extract it transparently; a single trace spans
  the gateway → retail → inventory → notification flow without any
  manual context plumbing at adapter boundaries.

**Architectural boundary.** `@nestjs/microservices`, `amqplib`, and
`amqp-connection-manager` may be imported **only** from files under
`infrastructure/messaging/*-rabbitmq.{adapter,publisher}.ts` (or the
equivalent `*-rabbitmq.adapter.ts` at the gateway). The architecture
lint (ADR-017) enforces this; every consumer outside the adapter layer
goes through a port (`IInventoryGatewayPort`,
`IInventoryConfirmGatewayPort`, `IOrderEventsPublisherPort`,
`IStockEventsPublisherPort`, etc.).

**Failure semantics.** RPC failures bubble up as
`RpcException`s and are translated to HTTP errors by the gateway via
`throwRpcError`. Event publishes are best-effort; a publish failure on
the create/confirm post-commit path is `warn`-logged but not raised —
the aggregate is already persisted, and the notification fan-out is a
best-effort step. There is no transactional outbox today; a future ADR
introduces one if at-least-once cross-service event delivery becomes a
hard requirement.

---

## Alternatives Considered

**Apache Kafka.** Rejected for this project. Kafka's strengths —
partitioned, replayable, ordered logs with consumer-group offsets —
solve problems that a few RPC and event flows per second don't yet have.
RabbitMQ's per-message ack/nack model is the better fit for
request/response and for the small, low-fan-out event surface today.
Operational footprint matters: Kafka brings ZooKeeper or KRaft + brokers
+ schema registry + offset commit semantics; RabbitMQ is one container.
Revisitable if the event surface grows to need partitioning or replay.

**NATS / NATS JetStream.** Rejected. NATS is lighter than Kafka and
faster than RabbitMQ at small payloads, and JetStream adds durable
streams. The trade-off is community size (RabbitMQ has the most
NestJS-ecosystem documentation), the maturity of the
`@nestjs/microservices` RMQ transport (one `Transport.RMQ` line; NATS
is supported but less battle-tested in NestJS), and operational
familiarity. NATS is a reasonable future swap if the project hits a
RabbitMQ performance ceiling — the adapter layer the architecture lint
enforces makes the swap surgical.

**Redis Streams or Redis pub/sub.** Rejected. The project already runs
Redis for the cache layer (ADR-002, ADR-006, ADR-016); reusing it as
the bus would collapse one dependency at the cost of conflating two
roles. A Redis outage today degrades the cache to "miss-and-DB-read"
(graceful); making it the message bus too would turn the same outage
into "no inter-service traffic" (catastrophic). Operational separation
of concerns is worth the second container.

**Direct service-to-service HTTP.** Rejected. HTTP couples each service
to the hostnames and availability of every other service; it would need
a service-discovery layer, retry-with-backoff, and circuit-breaker
plumbing built per-call. RabbitMQ provides the decoupling for free —
the producer doesn't know which (or how many) consumers exist, and the
broker absorbs transient consumer outages. The cross-service confirm
flow (ADR-013) specifically benefits from this: a slow inventory
microservice queues work rather than 503-ing the gateway.

**gRPC.** Rejected. gRPC's streaming, code-generation, and strict
contracts are excellent for high-throughput request/response, but the
project's event-driven side
(`retail.order.created`, `inventory.stock.low`) maps awkwardly to gRPC's
RPC-centric model. The
`@retail-inventory-system/contracts/microservices` layer already gives
us the typed-contract benefit without the protobuf compile step.

**An in-process event bus (no broker).** Rejected. Three services run as
separate processes; cross-process traffic is the whole point of the
bus. An in-process bus only works inside a single monolith, which is
not the deployment topology.

---

## Consequences

### Positive

- Producer/consumer decoupling for free: queue durability absorbs
  consumer outages and back-pressure spikes. A slow inventory service
  doesn't 503 the gateway.
- One transport for both RPC and events. `@nestjs/microservices` gives
  us a uniform `ClientProxy` API for both patterns; the same `RmqOptions`
  factory configures both sides.
- The amqplib auto-instrumentation (ADR-014) propagates
  `traceparent` through AMQP message properties — every cross-service
  trace is a single tree in Jaeger with no manual context-plumbing
  code.
- Architecture lint (ADR-017) collapses the broker-aware surface to a
  small set of adapter files. Every other layer is broker-agnostic and
  unit-testable against in-memory port stubs.
- Single operational dependency: one `rabbitmq` container locally, one
  managed broker in production.

### Negative / Trade-offs

- RabbitMQ is a single point of failure for inter-service traffic. A
  broker outage halts every cross-service flow. Mitigated by RabbitMQ's
  operational maturity, by `amqp-connection-manager`'s reconnect logic,
  and by the gateway returning RPC timeouts cleanly (no
  half-state). Production HA is a clustering/mirror concern, not a code
  concern.
- At-least-once event delivery is the broker's default, but the
  project's event publishes are not transactionally tied to DB commits
  — a successful commit followed by a broker-down moment can drop the
  follow-up emit. The post-commit publishes log a warning rather than
  raise. A transactional-outbox ADR is a credible future addition if
  the event surface grows to demand stronger guarantees.
- No replay semantics. A consumer that misses a message because it was
  offline (e.g. notification microservice down during an
  `inventory.stock.low` emit) does not see the message later. The
  events are advisory today; an outbox + replayable log would change
  this contract.
- Routing-key wire format changes are coordinated across all four apps
  in one PR (ADR-008 records the snake_case → dotted cutover for this
  reason). A polyrepo split or independent release cadence would
  complicate this.

---

## References

- `libs/messaging/` — RabbitMQ wiring, routing keys, exchange
  constants.
- `libs/contracts/microservices/` — queue / pattern / client-token /
  app-name enums, `ICorrelationPayload`.
- `apps/*/src/modules/*/infrastructure/messaging/` — the only allowed
  home for `@nestjs/microservices` imports.
- [ADR-008](008-rabbitmq-via-libs-messaging.md) — the messaging library
  wiring and the dotted routing-key wire format.
- [ADR-013](013-order-aggregate-and-cross-service-confirm.md) — the
  cross-service confirm flow that exercises the RPC pattern
  end-to-end.
- [ADR-011](011-notifier-port-and-adapters.md) — the event-driven
  notification flow that exercises `@EventPattern`.
- [ADR-014](014-otel-exporter-otlp-http-and-jaeger.md) — the OTel
  amqplib auto-instrumentation that propagates `traceparent` across
  every broker hop.
- [ADR-017](017-architecture-lint-via-eslint-boundaries.md) — the lint
  rules that confine `@nestjs/microservices` / `amqplib` to the
  adapter layer.
