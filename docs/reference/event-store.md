# Event store

This file covers what the event store (`apps/event-store-microservice/src/`) does today that its
names and types do not say: the hybrid boot, what its two queues do with a message, the firehose
ingest into `domain_event` and `audit_log_entry`, the three `audit.*` reads, and the `parseInstant`
time-zone pin. Paths below are relative to `modules/audit-and-events/` unless they start with
`main.ts` or at the repository root. The rationale lives in the ADRs:

- [ADR-034](../adr/034-isolated-eventstore-database.md): the isolated `ris_eventstore` database.
- [ADR-035](../adr/035-event-store-firehose-topic-exchange.md): the `ris.events` topic exchange,
  producer dual-publish, the one firehose queue and `audit.staff.action`.
- [ADR-039](../adr/039-audit-and-event-store-query-surface.md): the query surface, the second
  queue, and the two `correlation_id` columns (§6).
- [ADR-042](../adr/042-one-bounded-context-one-module.md): one module for the whole context.

The tables, the dedupe key, the frozen value objects and the RPC keys are in
[`README.md` §4](../../README.md#event-store-and-audit-log-event-store-microservice); the HTTP
routes and filters are in [§6](../../README.md#audit-and-event-store-staff-only). The wire shapes
of `audit.staff.action` and the query payloads are in
[`wire-contracts.md`](wire-contracts.md#audit-and-event-store).

## Boot

`main.ts` is the repository's only hybrid Nest application: `NestFactory.create`, two
`connectMicroservice` calls, `app.init()`, then `app.startAllMicroservices()`.

- **`app.init()` must run before `startAllMicroservices()`.** `startAllMicroservices()` only calls
  each microservice's `listen()`, which runs no lifecycle hook.
  `NestApplication.connectMicroservice` in `@nestjs/core` has already marked each
  `NestMicroservice` as initialized, so nothing else runs them either. `onModuleInit` and
  `onApplicationBootstrap` run in `app.init()`, and calling it first means they have all run before
  either queue delivers a message.
- **The service opens no TCP port.** `NestFactory.create` builds an HTTP adapter, but nothing calls
  `app.listen()`.
- **Every handler is bound on both transports**
  ([ADR-039](../adr/039-audit-and-event-store-query-surface.md) §3).
  With `wildcards: true`, `ServerRMQ` binds every registered pattern as a routing key on
  `ris.events`. So `event_store_firehose_queue` carries five bindings on that exchange: `#`, plus
  inert bindings for `audit.event.query`, `audit.entry.query`, `audit.trace.by-correlation` and the
  health key `audit.health.ping` (`app/health.controller.ts`). Nothing publishes the last four to
  `ris.events`. A probe with the same transport options showed all five bindings.

## What the queues do with a message

- **Nothing ever acknowledges a message on `event_store_firehose_queue`.** Its transport sets
  `noAck: false`. `FirehoseConsumer` does not take the channel from its `RmqContext`, and
  `ServerRMQ` in `@nestjs/microservices` 11.1.19 acks nothing itself: `handleEvent` only `nack`s a
  message that has no handler. The behaviour is the one described for `notification_events` in
  [`notifications.md`](notifications.md#what-the-queue-does-with-a-message):
  - Every handled event is delivered again whenever the channel closes: on every stop or restart,
    and whenever a delivery stays unacknowledged longer than RabbitMQ's `consumer_timeout`
    (30 minutes by default).
  - A probe with this service's exact transport options (`NestFactory.create`, a topic exchange,
    `wildcards: true`, a second default-exchange queue) and `rabbitmq:4.2.3` received one
    `retail.order.placed` and one `audit.staff.action` again on each of three restarts. Both stayed
    in the queue after each close.
- **So nothing ever leaves the firehose queue.** Every event published on `ris.events` since the
  queue was declared stays there. Each reconnect delivers all of them again, and the default
  prefetch of `0` sets no limit on how many arrive at once.
- **What a redelivery does:**
  - `domain_event` absorbs it on the composite UNIQUE: `append` returns `{ inserted: false }`.
  - `audit_log_entry` has no dedupe key, so every redelivered `audit.staff.action` is a new row.
    Each channel close adds another copy of every staff action ever recorded.
  - An event that an earlier delivery dropped is offered again. A drop caused by a database outage
    is recovered on the next channel close. A drop caused by bad input (see the ingest sections
    below) repeats on every delivery.
- **`event_store_query_queue` acks on delivery.** Its transport leaves `noAck` at the `ServerRMQ`
  default of `true`, so RabbitMQ considers an RPC done once it is handed to the consumer. A request
  in flight when the process dies is lost, and the gateway caller times out.

## Firehose consumer

`presentation/firehose.consumer.ts`, `FirehoseConsumer.onFirehoseEvent`, is the queue's one
`@EventPattern('#')` handler.

- **It reads the routing key from `message.fields.routingKey`.** The mirror publisher emits with the
  routing key equal to the pattern, so `RmqContext.getPattern()` would return the same concrete
  key. It never returns `#`.
- **`audit.staff.action` goes to `IngestAuditLogUseCase`, and every other key to
  `IngestDomainEventUseCase`.** An audit action never appears in `domain_event`.
- **Nothing is rethrown.** Both use cases catch their own failures, and the consumer's `try`/`catch`
  also logs anything else at `warn` (`Firehose ingest failed — dropping message`). A rethrow would
  make no difference: `RpcExceptionsHandler` would log it, and no `nack` would follow.
- **A successful ingest logs only at `debug`.** At the default `info` level the firehose is silent
  unless an event is dropped.

## Ingest into `domain_event`

`application/use-cases/ingest-domain-event.use-case.ts`, `IngestDomainEventUseCase.execute`.

- **A missing or unparseable `occurredAt` drops the event permanently.** The use case logs at `warn`
  and returns. Every redelivery drops it again. `occurredAt` is part of the dedupe key, so it is
  never defaulted.
- **`eventVersion` is stored as sent when it is a string, and as `v1` otherwise.**
- **`producer`, `aggregate_type` and `aggregate_id` are guessed**
  (`application/use-cases/firehose-extractors.ts`):
  - `producer` maps the first routing-key token to an `AppNameEnum` value (`inventory`, `retail`,
    `catalog`, `notification`, `notifications`). Any other token is stored as it is: the gateway's
    `customer.*` events have the producer `customer`.
  - `aggregate_type` is the second token.
  - `aggregate_id` is the first key of `AGGREGATE_ID_KEYS` that holds a string or a number. The
    list is a fixed precedence, and `orderId` comes before every per-aggregate id except
    `aggregateId` and `id`.
- **So an event is filed under the order when it carries an `orderId`.** What the published
  payloads resolve to:

  | Routing keys                                                               | `aggregate_id` |
  | -------------------------------------------------------------------------- | -------------- |
  | `retail.order.*`, `.payment.*`, `.fulfillment.*`, `.refund.*`, `.return.*` | `orderId`      |
  | `inventory.stock.allocated`, `inventory.stock.committed`                   | `orderId`      |
  | every other `inventory.stock.*`, `inventory.stock-level.initialized`       | `variantId`    |
  | `inventory.stock-movement.recorded`                                        | `variantId`    |
  | `catalog.variant.created`, `catalog.price.*`                               | `variantId`    |
  | `retail.cart.line-added`                                                   | `variantId`    |
  | the other three `retail.cart.*`                                            | `cartId`       |
  | `notifications.delivery.failed`                                            | `deliveryId`   |
  | `catalog.product.*`, `customer.consent.updated`, `customer.erased`         | `''`           |

  `rmaId`, `productId`, `customerId` and `lineId` are not in the list, and `fulfillmentId`,
  `paymentId` and `refundId` come after `orderId`. So
  `?aggregateType=payment&aggregateId=<paymentId>` matches nothing; a payment event is found by its
  order id. The field sets are those of the event contracts under `libs/contracts/*/events/`.

- **The dedupe key can merge two different events.** The UNIQUE covers `producer`, `event_type`,
  `aggregate_id`, `occurred_at` and `correlation_id`, and `occurred_at` has millisecond precision.
  Two distinct events of one type that share the guessed `aggregate_id`, the millisecond and the
  correlation id are stored once. The second is logged at `debug` as a duplicate.
  - This happens on every multi-line Allocate and Commit Sale. `AllocateStockUseCase.execute` and
    `CommitSaleUseCase.execute` build one event per line inside one synchronous `map`, so their
    `occurredAt` values fall in the same millisecond. Every line's `inventory.stock.allocated` or
    `inventory.stock.committed` resolves to the same `orderId`.
  - A probe ran three lines through the real `StockRabbitmqPublisher` and
    `IngestDomainEventUseCase`, with the UNIQUE checked in memory. In each of five runs it stored
    one of the three `inventory.stock.allocated` and two of the three `inventory.stock.committed`.
    The first `committed` event fell into an earlier millisecond only because it was the process's
    first publish.
  - An event with an empty `aggregate_id` collides with any event of the same type in the same
    millisecond under the same correlation id.
- **An over-long value loses the event.** `correlation_id` is `VARCHAR(64)` in both tables, and
  `aggregate_type` and `producer` are `VARCHAR(32)`. The pinned `mysql:8.4.8` image runs with
  `STRICT_TRANS_TABLES`, and `DatabaseModule` does not change `sql_mode`. An over-long insert fails
  with `ER_DATA_TOO_LONG` (checked against that image for a 65-character `correlation_id`). The use
  case logs at `warn` and drops the event. The gateway's `CorrelationMiddleware` accepts an
  `x-correlation-id` header of any length, so a client that sends more than 64 characters loses
  every firehose row and every audit row of that request.
- **Any other insert failure is swallowed the same way.** Only `ER_DUP_ENTRY` is translated to
  `{ inserted: false }` (`infrastructure/persistence/domain-event-typeorm.repository.ts`,
  `isDuplicateEntryError`, which checks the error and its `driverError`).

## Ingest into `audit_log_entry`

`application/use-cases/ingest-audit-log.use-case.ts`, `IngestAuditLogUseCase.execute`.

- **Three inputs are dropped with a `warn`:** an `actorType` other than `staff-user` or `system`,
  a missing or unparseable `occurredAt`, and an empty `action`. The first two are checked by the
  use case. The empty `action` makes `AuditLogEntry.create` throw a plain `Error`, which the use
  case catches.
- **The row is always a new insert.** `AuditLogEntryTypeormRepository.append` does not translate
  `ER_DUP_ENTRY`: the table has no unique key besides the primary key, so a duplicate error can only
  mean a schema fault, and swallowing it would lose an audit row silently. The consequence is that
  every redelivery is a duplicate row (see [above](#what-the-queues-do-with-a-message)).
- **`correlation_id` is never `NULL` in practice.** The use case writes `event.correlationId ?? ''`,
  so a row without a correlation id holds `''`, even though the column is nullable
  ([`wire-contracts.md`](wire-contracts.md#auditstaffaction)).

## `DomainEvent` and `AuditLogEntry`

- **`reconstitute` re-runs the invariants.** A stored row with an empty `event_type`, `producer`
  or `action`, or an unknown `actor_type`, would make the whole query or trace RPC fail with a plain
  `Error`. The ingest never writes such a row.
- **`received_at` is not modelled.** Neither domain model nor view carries it, so the ingest lag
  (`received_at − occurred_at`) is visible only in SQL.

## Reads

`QueryDomainEventsUseCase`, `QueryAuditLogEntriesUseCase` and `TraceByCorrelationUseCase`, served
by `presentation/audit-query.controller.ts`.

- **A filter is used when it is not `undefined`.** The repositories copy each defined field of
  `filters` into a TypeORM `where`, as an equality
  (`DomainEventTypeormRepository.query`, `AuditLogEntryTypeormRepository.query`). A missing
  `filters` object is read as `{}`.
- **Not every filter uses an index.** The indexes are those of the two eventstore migrations under
  `migrations/eventstore/`. `occurred_at` is only a trailing column of each composite index.
  `EXPLAIN` on `mysql:8.4.8` with the migration DDL and 50 000 rows per table:

  | Filter set                                                             | Plan                 |
  | ---------------------------------------------------------------------- | -------------------- |
  | `eventType`, `aggregateType` + `aggregateId`, `actorId`, `action`      | index, then filesort |
  | `correlationId`                                                        | index, then filesort |
  | `aggregateId` without `aggregateType`, `entityId` without `entityType` | full scan, filesort  |
  | only `from` / `to`, or no filter at all                                | full scan, filesort  |

  The unfiltered default page of `GET /api/audit/events` and `GET /api/audit/entries` therefore
  scans and sorts the whole table on every call, and both tables only grow.

- **An unparseable `from` or `to` is dropped, not rejected.** `parseInstant` returns `undefined`
  for it, so the window widens. That includes a well-formed but impossible instant such as
  `2026-13-45T99:99:99`: kept as `Invalid Date`, it would make the page empty instead of
  unfiltered. The gateway DTOs' `@IsISO8601()` rejects that one, but it accepts forms `Date` cannot
  read — a week date, an ordinal date, the basic format — so those widen the window over HTTP too
  ([`api-gateway.md`](api-gateway.md#time-bounds)).

## `parseInstant`

`infrastructure/persistence/parse-instant.ts`, shared by both repositories.

- **A date-time without a zone is read as UTC.** `new Date('2026-06-01T00:00:00')` resolves in the
  host's local zone, and `@IsISO8601()` accepts that form. `parseInstant` appends `Z` to a string
  that matches `ZONELESS_DATE_TIME`. The pattern admits fractional seconds (`[\d:.]+`).
- **Two forms are left alone:** a string with a numeric offset (`+02:00`), which the caller meant,
  and a date-only string (`2026-06-01`), which JavaScript already reads as UTC.
- **The spec runs the function in child processes, one per `TZ`**
  (`infrastructure/persistence/spec/parse-instant.spec.ts`). Setting `process.env.TZ` inside a
  Jest test reads back correctly but does not move the zone: Jest gives the test a copy of
  `process.env`, so Node's time-zone reset never fires. In a plain Node process the same assignment
  does move it. On a UTC host (CI pins no `TZ`), an in-process test of the pin would pass even if
  the function did nothing.

## Failure modes

- **The service restarts, or `consumer_timeout` fires.** The whole firehose queue is delivered
  again, and `audit_log_entry` gains another copy of every staff action. `domain_event` absorbs its
  share on the UNIQUE. Nothing in the code recovers the audit duplicates.
- **Events accumulate.** `event_store_firehose_queue` only grows, because nothing is ever acked.
- **Two events share the guessed key and millisecond.** One `domain_event` row is stored instead
  of two, with a `debug` "Duplicate domain_event dropped" line. The second event is gone from the
  log.
- **`occurredAt` is missing or invalid.** A `warn` "missing or invalid occurredAt" and no row, on
  every delivery. Only a corrected publish from the producer recovers it.
- **A value is longer than its column.** A `warn` "Failed to ingest" and no row, on every delivery.
- **`ris_eventstore` is down during ingest.** A `warn` "Failed to ingest" and no row. The next
  channel close delivers the event again.
- **The mirror publish to `ris.events` fails at a producer.** No row at all. The producer logs a
  `warn` with the routing key and the whole payload, which is the only copy to replay from
  ([`shared-libraries.md`](shared-libraries.md#messaging)).
- **A query filters only on `aggregateId`, `entityId` or the time window.** A slow page: a full
  scan and a filesort. Adding `aggregateType`, `entityType` or another leading-column filter uses
  an index.
- **The process dies while serving a query.** The gateway request times out. The query queue does
  not redeliver, so the caller has to retry.
