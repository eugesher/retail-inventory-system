# task-05 — Write messaging articles (Phase: messaging/) — DRAFT

> **DRAFT — may be revised by task-01.**

## Context

- Migration source of truth: ADR-020 (RabbitMQ as the bus),
  ADR-008 (`libs/messaging` wiring + dotted routing keys),
  ADR-011 (event-pattern subscribers in notification),
  ADR-013 (cross-service confirm RPC),
  `parts/recommendation.md` Section 4 (routing-key convention).
- Previous carryover:
  `docs/architecture-migration-ru/tasks/_carryover-04.md`
  (READ FIRST).
- Guide root: `docs/architecture-migration-ru/architecture-migration-guide.md`.
- Conventions preamble: see `task-01-survey-and-scaffold.md`.
- Where the guide stands: concepts, project shape, and persistence
  are written. The reader can place an aggregate in the codebase.
  This task covers the inter-service transport — every cross-service
  call uses RabbitMQ, so every architectural decision downstream
  (auth-on-the-wire, observability via `traceparent`, the gateway
  port/adapter split) leans on this group.

## Prerequisites

- [ ] `_carryover-04.md` exists and was read first.
- [ ] Build is green on entry.
- [ ] HEAD SHA is recorded in `_carryover-01.md`.

## Goal

Walk the reader through the RabbitMQ-based messaging stack: why
RabbitMQ over Kafka/NATS/HTTP (ADR-020); how `@nestjs/microservices`
wraps `amqplib` via `amqp-connection-manager`; the
`@MessagePattern` (RPC) vs `@EventPattern` (event) distinction; and
the dotted `<service>.<aggregate>.<action>` routing-key convention
that lives in `libs/messaging`.

## Article slots to fill

- [ ] `docs/architecture-migration-ru/messaging/rabbitmq-as-bus.md`
- [ ] `docs/architecture-migration-ru/messaging/nest-microservices-transport.md`
- [ ] `docs/architecture-migration-ru/messaging/message-vs-event-patterns.md`
- [ ] `docs/architecture-migration-ru/messaging/routing-keys-and-contracts.md`

> Approximate guidance per article:
>
> - **rabbitmq-as-bus** — ~2000 words. Why RabbitMQ (ADR-020). The
>   broker, the `RABBITMQ_URL`, the queue-per-service model
>   (`retail_queue`, `inventory_queue`, `notification_events`),
>   and the default-exchange wiring with reserved `EXCHANGES`
>   constants for future topic-routing.
> - **nest-microservices-transport** — ~1500 words. `Transport.RMQ`,
>   `app.connectMicroservice(...)` in `main.ts`, `ClientProxy`
>   ergonomics (Observable → `firstValueFrom` → Promise). The
>   "`ClientProxy` only inside `infrastructure/messaging/*-rabbitmq.{adapter,publisher}.ts`"
>   boundary rule from ADR-009 / ADR-012 / ADR-013.
> - **message-vs-event-patterns** — ~1500 words. RPC
>   (`ClientProxy.send` + `@MessagePattern`, with a typed response)
>   vs event (`ClientProxy.emit` + `@EventPattern`, fire-and-forget,
>   fan-out). When to use each. Use the real flow
>   (`retail.order.confirm` is RPC; `retail.order.created` is event).
> - **routing-keys-and-contracts** — ~1500 words. The dotted
>   `<service>.<aggregate>.<action>` convention from ADR-008. The
>   double-source-of-truth pair (`ROUTING_KEYS` in `libs/messaging` +
>   `MicroserviceMessagePatternEnum` in `libs/contracts/microservices`)
>   and the spec that asserts they agree. The wire-format cutover
>   from snake_case to dotted.

## Steps

1. **Read previous carryover.**
2. **Read the source ADRs.** ADR-020 (full), ADR-008 (full),
   ADR-011 §4 (consumers as infrastructure), ADR-013 §3 (the
   cross-service gateway port pattern).
3. **Author each article.** Suggested anchors (verify in task-01):
   - **rabbitmq-as-bus**:
     `libs/messaging/microservice-client.configuration.ts`,
     `libs/contracts/microservices/microservice-queue.enum.ts`,
     `apps/inventory-microservice/src/main.ts`
     (`connectMicroservice` block), `libs/messaging/exchanges.constants.ts`
     (reserved exchange constants).
   - **nest-microservices-transport**:
     `libs/messaging/rabbitmq.client.factory.ts`,
     `libs/messaging/messaging.module.ts`,
     `apps/inventory-microservice/src/modules/stock/infrastructure/messaging/stock-rabbitmq.publisher.ts`
     (verify exact path).
   - **message-vs-event-patterns**:
     `apps/retail-microservice/src/modules/orders/presentation/orders.controller.ts`
     (`@MessagePattern` handlers), `apps/notification-microservice/src/modules/notifications/infrastructure/consumers/order-events.consumer.ts`
     (`@EventPattern` subscriber).
   - **routing-keys-and-contracts**:
     `libs/messaging/routing-keys.constants.ts`,
     `libs/contracts/microservices/microservice-message-pattern.enum.ts`,
     `libs/messaging/spec/routing-keys.constants.spec.ts` (verify).
4. **Mention `ICorrelationPayload`** in `routing-keys-and-contracts`
   — every wire payload extends this interface so `correlationId`
   threads through. This sets up the observability group later.
5. **Cross-link** to `[[api-gateway-pattern]]`,
   `[[hexagonal-architecture]]`, `[[module-boundaries]]`. The
   `routing-keys-and-contracts` article links forward to
   `[[trace-log-correlation]]`.

## Verification

- [ ] Four articles filled, no `заглушка` callouts.
- [ ] Permalinks pinned to the recorded SHA on every excerpt.
- [ ] Every wiki link resolves.
- [ ] No orphans.

## Carryover

Write `_carryover-05.md` per the standard structure.
