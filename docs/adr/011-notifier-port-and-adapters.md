# ADR-011: NotifierPort and the notification microservice as the per-module template

- **Date**: 2026-05-13
- **Status**: Accepted

---

## Context

Before the notification microservice was built out, it (`apps/notification-microservice/`)
was a stub: `AppModule` registered `ConfigModule` and `LoggerModule`, `main.ts`
connected to the `notification_events` RabbitMQ queue, and nothing else
existed. No handlers, no business logic, no delivery channels.

ADR-004 established hexagonal-per-service as the target layout, ADR-008
locked the RabbitMQ wire format, and ADR-009 produced the gateway-side
realisation of the pattern. Inventory and retail are still on the legacy
flat layout and migrate later. This work stands up the notification
microservice **correctly the first time** so it can serve as the canonical
per-module template that the bigger services copy from — a fresh build is
cheaper to shape than a reshape, and the template is more useful before
the harder migrations rather than after.

## Decision

### 1. The notification microservice owns the per-module template

**Chosen.** The notification module under
`apps/notification-microservice/src/modules/notifications/` is the
reference shape for every microservice's bounded context:

```
modules/notifications/
  domain/          # value objects, enums, invariants. No `@nestjs/*`.
  application/
    ports/         # port interfaces + DI symbols (Symbol-based)
    use-cases/     # one class per use case; inject ports, not adapters
  infrastructure/
    consumers/     # @EventPattern / @MessagePattern subscribers (RMQ)
    delivery/      # NOTIFIER adapters: log, email, webhook
    *.module.ts    # binds port symbols to concrete adapters
  presentation/    # RMQ-only here (health); HTTP for services that need it
```

The inventory and retail hexagonal alignments copy this shape verbatim per bounded
context. The split mirrors the gateway's `modules/auth/` and `modules/retail/`
layouts so the project has one shape across services — not "hexagonal-style
but slightly different per service."

### 2. `NotifierPort` is the outbound abstraction

**Chosen.** Application code depends on `INotifierPort { send(Notification) }`,
not on a specific delivery mechanism. The DI symbol is `NOTIFIER` (a
`Symbol`, not a string token — the same convention `RETAIL_GATEWAY_PORT` /
`USER_REPOSITORY` use). `notifications.module.ts` binds `NOTIFIER` to a
concrete adapter; swapping log → email → webhook is a one-line `useClass`
change once the target adapter is implemented.

**Rejected: a `NotifierService` concrete with feature flags for channels.**
Conflates delivery selection with business logic and forces every
adapter's dependencies onto the use case. A port + multiple adapters keeps
the use case free of webhook URLs, SMTP creds, and provider SDKs.

### 3. `LogNotifierAdapter` is the default binding

**Chosen.** The default `NOTIFIER` binding is `LogNotifierAdapter`, which
emits the notification as a structured Pino info line. This is the
implementation the smoke test exercises end-to-end.

Rationale: a logging notifier is the only adapter that has zero external
dependencies and can be reasoned about in unit tests with a Pino spy.
Email and webhook adapters need network reachability, transport
credentials, and retry policies — none of which are appropriate to wire
on the migration's critical path. `EmailNotifierAdapter` and
`WebhookNotifierAdapter` exist as scaffolds (TODOs) so the DI slot is
visible and the rebind is a one-line change when the real implementation
arrives.

### 4. Consumers are infrastructure, not presentation

**Chosen.** RabbitMQ subscribers live under `infrastructure/consumers/`.
They are thin adapters that translate wire-format payloads
(`IRetailOrderCreatedEvent`, `IInventoryStockLowEvent`) into use-case
invocations, exactly the same way that HTTP controllers are
presentation-layer adapters from URL + JSON body into use-case calls.

In the legacy flat layout, these handlers lived under `app/api/*`
alongside controllers, which conflated outbound (RMQ subscribe) with
inbound (HTTP route). The per-module split separates the two concerns:
`presentation/` is for HTTP, `infrastructure/consumers/` is for RMQ.

### 5. Events are framework-free interfaces in `libs/contracts`

**Chosen.** `IRetailOrderCreatedEvent` and `IInventoryStockLowEvent` are
plain TypeScript interfaces in `libs/contracts/retail/events/` and
`libs/contracts/inventory/events/`. They extend `ICorrelationPayload` so
log correlation works end-to-end, and they carry an `occurredAt` ISO
string so consumers can reason about ordering without trusting broker
timestamps.

**Rejected: domain `DomainEvent<TId>` subclasses for cross-service
events.** Those types live in `libs/ddd` and are designed for in-process
aggregate-event dispatch. Cross-service wire format must be a plain JSON
shape — no class identity to serialize, no `@nestjs/*` decorators to drag
along. The two concerns share a name but not a representation; conflating
them would force every consumer to reconstruct the class on receipt.

### 6. The microservice has no HTTP surface

**Chosen.** The notification microservice is RMQ-only. The health check
rides the same transport as the event subscribers via
`@MessagePattern('notification.health.ping')`. If a gateway-side
`GET /health/notification` is added later, it proxies to this pattern.

**Rejected: a small HTTP server in the notification process.** Adds a
second listener, a second port to expose in Docker, and a second
liveness mechanism for orchestration to monitor. The RMQ-only
deployment surface is smaller and matches the service's role (it has
no client requests — only broker events).

### 7. Correlation goes on the log line, not via `PinoLogger.assign`

**Chosen.** Use cases log `correlationId` inline on each `logger.info()`
call. `PinoLogger.assign()` only works in nestjs-pino's request-scope
mode, and event-pattern handlers are not request-scoped (no HTTP
context). Attempting `assign()` inside an `@EventPattern` handler throws
`PinoLogger: unable to assign extra fields out of request scope`.

This differs from the gateway use cases (e.g. `CreateOrderUseCase`) which
do call `assign()` — those are invoked from HTTP controllers and inherit
the request scope. The convention is: **inside an `@EventPattern` /
`@MessagePattern` handler, pass `correlationId` as a log field; inside
an HTTP controller path, `assign()` is fine.**

### 8. Reuse the existing `notification_events` queue

**Chosen.** The earlier stub already connected to the
`notification_events` queue; the migrated service keeps the same queue
name (`MicroserviceQueueEnum.NOTIFICATION_EVENTS`). The `EXCHANGES.NOTIFICATION`
constant in `libs/messaging/exchanges.constants.ts` is reserved for a
future topic-exchange migration; today the queue is bound to the default
exchange and the `pattern` field in the message envelope routes inside
the consumer.

## Consequences

- The notification microservice now consumes `retail.order.created` and
  `inventory.stock.low`. **Neither producer exists yet** — they arrive in
  the inventory and retail hexagonal alignments. The smoke test
  `test/notification.e2e-spec.ts` exercises the full consumer → use-case
  → notifier path by publishing a synthetic event directly to the queue.
- `libs/contracts` gains two new sub-areas: `retail/events/` and
  `inventory/events/`. ADR-008's wire-format conventions extend to events
  unchanged.
- `ROUTING_KEYS` and `MicroserviceMessagePatternEnum` gain three new
  values: `RETAIL_ORDER_CREATED`, `INVENTORY_STOCK_LOW`,
  `NOTIFICATION_HEALTH_PING`. The spec in `libs/messaging/spec/` asserts
  both libs agree on every value.
- `EmailNotifierAdapter` and `WebhookNotifierAdapter` are scaffolds that
  throw `not implemented` on `send()`. No new runtime dependencies
  (`nodemailer`, `axios`, etc.) were added — deferred until the adapter
  is actually wired post-migration.
- The inventory and retail alignments will copy the notification module's directory layout
  verbatim. If they need to deviate, the deviation should land here as a
  follow-up ADR rather than silently in the code.

## Alternatives considered (summary)

| Decision | Picked | Rejected | Why |
| -------- | ------ | -------- | --- |
| Outbound abstraction | `NotifierPort` (port + adapters) | `NotifierService` (concrete w/ feature flags) | Keeps use cases free of provider SDKs / creds. |
| Default delivery | Log adapter | Email adapter | Zero external deps; testable with a Pino spy. |
| Cross-service event shape | Plain JSON interfaces in `libs/contracts` | `DomainEvent<TId>` subclasses | Wire format ≠ aggregate-internal events. |
| HTTP surface on notification | None — RMQ-only | Small HTTP server for health | Smaller deployment surface. |
| Correlation in event handlers | Inline log field | `PinoLogger.assign` | `assign` only works in request scope. |
| Build order | Notification first (template) | Notification last (after big services) | Template before reshape, not after. |

## References

- ADR-004 — hexagonal-per-service.
- ADR-008 — RabbitMQ wire format (`<service>.<aggregate>.<action>`).
- ADR-009 — gateway port/adapter split (the layout this module mirrors).
- ADR-010 — JWT/RBAC at the gateway (first gateway module with a real
  `domain/`; this ADR is the first microservice equivalent).
- ADR-020 — RabbitMQ as the inter-service bus that carries the events
  this module subscribes to.
