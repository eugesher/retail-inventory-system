# _carryover-07.md — Build Notification service (Phase 4)

> Generated 2026-05-13 by the task-07 session on branch
> `RIS-31-Architecture-migration-Phase-7-Build-Notification-service`.
> The next task (`task-08`) reads this file as its first action and fails
> fast if it is missing.

## 1. Entry-gate result

`yarn install`, `yarn build` (4 apps), `yarn lint`, `yarn test:unit` were all
green at the start of the session. Baseline matches `_carryover-06.md`'s
reported state.

## 2. Per-module template (copy-pasteable for tasks 08–09)

Tasks 08 (inventory) and 09 (retail) **copy this shape verbatim** per bounded
context inside each microservice's `src/modules/<bc>/`:

```
modules/<bounded-context>/
  domain/
    <aggregate-or-vo>.model.ts            # Aggregate or ValueObject from libs/ddd
    *.enum.ts                              # bounded-context enums
    events/                                # in-process DomainEvent<TId> subclasses (only if the aggregate emits them)
    index.ts                               # barrel
  application/
    ports/
      <name>.port.ts                       # I<Name>Port interface + NAME Symbol DI token
      index.ts
    use-cases/
      <verb>-<noun>.use-case.ts            # one class per use case; @Injectable; ctor injects ports
      index.ts
      spec/
        test-doubles.ts                    # in-memory port impls + FakeLogger
        <verb>-<noun>.use-case.spec.ts
    dto/                                   # command/query DTOs (optional, only if shapes differ from contracts)
  infrastructure/
    persistence/                           # TypeORM Entity, Mapper, Repository (only if the bc owns DB state)
    consumers/                             # @EventPattern / @MessagePattern subscribers (RMQ)
      <topic>-events.consumer.ts
      index.ts
    messaging/                             # OUTbound RabbitMQ adapters (ClientProxy lives here only)
      <name>-rabbitmq.adapter.ts
    delivery/                              # outbound adapters that aren't messaging (e.g. NOTIFIER impls)
    <bc>.module.ts                         # binds port symbols → adapters; lists controllers + providers
  presentation/
    *.controller.ts                        # HTTP (gateway) or RMQ-only health (notification)
    dto/                                   # request/response DTOs with class-validator + Swagger
    pipes/                                 # optional ParseXxxPipe etc.
```

**Reference implementation** for task-07: `apps/notification-microservice/src/modules/notifications/`.

Conventions baked into the template:

- Port DI tokens are `Symbol`s, not strings (e.g. `export const NOTIFIER = Symbol('NOTIFIER');`).
- Adapters implement port interfaces; modules bind `{ provide: NOTIFIER, useClass: LogNotifierAdapter }` (or `useExisting` to share a single instance with the concrete provider).
- Use cases inject ports via the symbol; never inject `ClientProxy` or `Repository<T>` directly.
- RMQ subscriber controllers (`@EventPattern` / `@MessagePattern`) live under `infrastructure/consumers/`, NOT under `presentation/`. Presentation is for the inbound *user-facing* surface (HTTP), consumers are infrastructure adapters from broker → use case.
- `domain/` MUST NOT import `@nestjs/*`, TypeORM, `@retail-inventory-system/messaging|cache|observability|database`. The boundary will be enforced by `eslint-plugin-boundaries` in task-12.
- Pattern strings for `@MessagePattern` / `@EventPattern` come from `ROUTING_KEYS` in `@retail-inventory-system/messaging`. No string literals at the call site.

## 3. Files created — paths + roles

### Cross-service contracts (framework-free)

| Path | Role |
|------|------|
| `libs/contracts/retail/events/order-created.event.ts` | `IRetailOrderCreatedEvent` + `IOrderCreatedEventProduct` — wire-format for `retail.order.created`. |
| `libs/contracts/retail/events/index.ts` | Barrel; re-exported from `libs/contracts/retail/index.ts`. |
| `libs/contracts/inventory/events/stock-low.event.ts` | `IInventoryStockLowEvent` — wire-format for `inventory.stock.low`. |
| `libs/contracts/inventory/events/index.ts` | Barrel; re-exported from `libs/contracts/inventory/index.ts`. |

### `libs/messaging` + `libs/contracts/microservices`

| Path | Change |
|------|--------|
| `libs/messaging/routing-keys.constants.ts` | Added `RETAIL_ORDER_CREATED`, `INVENTORY_STOCK_LOW`, `NOTIFICATION_HEALTH_PING`. |
| `libs/contracts/microservices/microservice-message-pattern.enum.ts` | Same three values added to the source-of-truth enum. |
| `libs/messaging/spec/routing-keys.constants.spec.ts` | Spec extended with assertions for all three new keys. |

### `apps/notification-microservice/src/modules/notifications/`

| Path | Role |
|------|------|
| `domain/notification.model.ts` | `Notification extends ValueObject<INotificationProps>`; constructor enforces non-empty recipient/subject/body and a known channel. |
| `domain/notification-channel.enum.ts` | `NotificationChannelEnum { LOG, EMAIL, WEBHOOK }`. |
| `domain/index.ts` | Barrel. |
| `domain/spec/notification.model.spec.ts` | 5 tests covering construction, invariants, and value-object equality. |
| `application/ports/notifier.port.ts` | `INotifierPort { send(Notification): Promise<void> }` + `NOTIFIER = Symbol('NOTIFIER')`. |
| `application/ports/index.ts` | Barrel. |
| `application/use-cases/send-order-notification.use-case.ts` | Consumes `IRetailOrderCreatedEvent`, builds a `Notification`, dispatches via `INotifierPort`. |
| `application/use-cases/send-low-stock-alert.use-case.ts` | Consumes `IInventoryStockLowEvent`, builds a `Notification`, dispatches via `INotifierPort`. |
| `application/use-cases/index.ts` | Barrel. |
| `application/use-cases/spec/test-doubles.ts` | `InMemoryNotifier` (records every send), `FakeLogger` (records `info` calls). |
| `application/use-cases/spec/send-order-notification.use-case.spec.ts` | 3 tests (dispatch content, correlationId log field, product count). |
| `application/use-cases/spec/send-low-stock-alert.use-case.spec.ts` | 2 tests (dispatch content + correlationId log field). |
| `infrastructure/delivery/log.notifier.adapter.ts` | Default `INotifierPort` impl; emits a Pino info line with every notification field. |
| `infrastructure/delivery/email.notifier.adapter.ts` | Scaffold — `send()` throws `EmailNotifierAdapter: not implemented`. No nodemailer dep added. |
| `infrastructure/delivery/webhook.notifier.adapter.ts` | Scaffold — `send()` throws `WebhookNotifierAdapter: not implemented`. No HTTP-client dep added. |
| `infrastructure/delivery/index.ts` | Barrel. |
| `infrastructure/delivery/spec/log.notifier.adapter.spec.ts` | 1 test asserting the exact Pino `info` call shape. |
| `infrastructure/consumers/order-events.consumer.ts` | `@EventPattern(ROUTING_KEYS.RETAIL_ORDER_CREATED)`, invokes `SendOrderNotificationUseCase`. |
| `infrastructure/consumers/inventory-events.consumer.ts` | `@EventPattern(ROUTING_KEYS.INVENTORY_STOCK_LOW)`, invokes `SendLowStockAlertUseCase`. |
| `infrastructure/consumers/index.ts` | Barrel. |
| `infrastructure/notifications.module.ts` | Binds `NOTIFIER` → `LogNotifierAdapter` (`useExisting` for single-instance shared with the concrete provider); registers all three controllers (consumers + health) and both use cases. |
| `presentation/health.controller.ts` | `@MessagePattern(ROUTING_KEYS.NOTIFICATION_HEALTH_PING)` returns `{ status: 'ok', service: 'notification-microservice' }`. |

### Bootstrap

| File | Change |
|------|--------|
| `apps/notification-microservice/src/main.ts` | Added `import '@retail-inventory-system/observability/tracer';` as the literal first line. Bootstrap body unchanged from the stub. |
| `apps/notification-microservice/src/app/app.module.ts` | Imports `NotificationsModule` alongside `ConfigModule` + `LoggerModule`. |

### Tests

| File | Coverage |
|------|----------|
| `apps/notification-microservice/src/modules/notifications/domain/spec/notification.model.spec.ts` | 5 tests — value-object invariants and equality. |
| `apps/notification-microservice/src/modules/notifications/application/use-cases/spec/send-order-notification.use-case.spec.ts` | 3 tests. |
| `apps/notification-microservice/src/modules/notifications/application/use-cases/spec/send-low-stock-alert.use-case.spec.ts` | 2 tests. |
| `apps/notification-microservice/src/modules/notifications/infrastructure/delivery/spec/log.notifier.adapter.spec.ts` | 1 test — Pino spy on the exact info call. |
| `libs/messaging/spec/routing-keys.constants.spec.ts` | Existing spec extended to cover the three new routing keys (no new file). |
| `test/notification.e2e-spec.ts` (new) | 1 e2e test — publishes synthetic `retail.order.created` to `notification_events` and asserts the LogNotifierAdapter received a Notification carrying the order id. Uses `jest.spyOn(LogNotifierAdapter.prototype, 'send')` to record calls while preserving the original Pino emit. |

Net new unit tests: **11** (in 4 new spec files; 1 existing spec extended).
Net new e2e tests: **1**.

### Documentation

| File | Change |
|------|--------|
| `README.md` | Updated the services table (`notification_events` queue, "fan-out of `retail.order.created` / `inventory.stock.low`" responsibility). Added a "Notification microservice layout" subsection under Architecture with the directory map + LogNotifierAdapter / DI-rebind paragraph + ADR-011 link. Rewrote the "Auth events" paragraph so it no longer says "task-07 wires" — it points at the now-existing template. |
| `CLAUDE.md` | Removed the "Notification microservice is a stub" Known-Issue line and replaced with the no-producer-yet caveat. Updated the `apps/` directory map. Updated the RabbitMQ queues paragraph and added `retail.order.created`, `inventory.stock.low`, `notification.health.ping` to the Message patterns list. Promoted the API gateway + notification microservice to "per-module hexagonal layout" together; added the "canonical per-module template" copy-pasteable block. Bumped the "next free ADR" counter to **012**. |
| `docs/adr/011-notifier-port-and-adapters.md` | New ADR. **Status: Accepted.** Covers: (1) notification module = canonical template, (2) `NotifierPort` over a concrete `NotifierService`, (3) `LogNotifierAdapter` as the default, (4) consumers belong in `infrastructure/`, not `presentation/`, (5) cross-service events as plain interfaces in `libs/contracts` (not `DomainEvent<TId>` subclasses), (6) RMQ-only deployment surface, (7) `correlationId` inline on log lines (NOT `PinoLogger.assign`) inside event-pattern handlers, (8) reuse of the existing `notification_events` queue. |

## 4. Email / Webhook adapter status

Both scaffolded as **stubs that throw `not implemented`**. No new runtime
dependencies added (no `nodemailer`, no HTTP client beyond what's already
present). Rationale: implementing them requires choosing a provider,
wiring credentials, and adding retry/back-off — work that belongs after
the migration. The DI slot exists in `notifications.module.ts` so the
switch is a one-line `useClass` change when the implementation arrives.

## 5. Unexpected findings

1. **`PinoLogger.assign` only works in nestjs-pino request scope.** The
   first draft of both use cases called `this.logger.assign({ correlationId })`,
   mirroring the gateway-side `CreateOrderUseCase`. That works inside
   HTTP controllers (the pino-http middleware sets up a per-request
   logger), but **throws `PinoLogger: unable to assign extra fields out of
   request scope` inside `@EventPattern` handlers** — RMQ-transport
   handlers have no HTTP context. Fix: pass `correlationId` as a log
   field on each `logger.info(...)` call. Captured as ADR-011 §7 so
   tasks 08–09 don't trip the same wire. (Side benefit: log records are
   self-contained, no implicit request-scope state.)

2. **`ValueObject<TProps>` requires `TProps extends Record<string, unknown>`.**
   `INotificationProps` initially was a plain `interface { recipient, ...
   metadata: Record<string, unknown> }` and TypeScript refused it because
   an interface does not implicitly satisfy the index-signature constraint.
   Fix: declared `interface INotificationProps extends Record<string,
   unknown>`. This is the first ValueObject subclass in the codebase
   (auth's `RoleVO` doesn't extend `ValueObject` — it predates the base
   class). Tasks 08–09 will create more value objects; expect the same
   incantation.

3. **`ClientProxy.emit()` returns a cold Observable.** The e2e smoke test
   originally called `publisher.emit(...)` and waited for the consumer —
   nothing arrived. Cold observables don't fire without a subscription;
   the test now does `await firstValueFrom(publisher.emit(...))` to
   trigger the publish AND wait for broker ack. Captured in the e2e spec
   as an inline comment. Tasks 08–09 will hit the same gotcha when their
   producers come online; the publisher-port that wraps `ClientProxy`
   should encapsulate this so application code never has to remember it.

4. **README claimed the queue was `notification_queue`.** Actually
   `MicroserviceQueueEnum.NOTIFICATION_EVENTS = 'notification_events'`.
   Fixed in the services table.

## 6. Verification results

```
$ yarn install
➤ YN0000: · Done in 2s 131ms

$ yarn build
webpack 5.106.0 compiled successfully in 9163 ms   # api-gateway
webpack 5.106.0 compiled successfully in 9843 ms   # inventory-microservice
webpack 5.106.0 compiled successfully in 9089 ms   # retail-microservice
webpack 5.106.0 compiled successfully in 9375 ms   # notification-microservice

$ yarn lint
# (no output — clean exit code 0)

$ yarn test:unit
Test Suites: 20 passed, 20 total
Tests:       96 passed, 96 total
Snapshots:   0 total
Time:        24.589 s

$ yarn test:e2e
Test Suites: 3 passed, 3 total
Tests:       35 passed, 35 total
Snapshots:   42 passed, 42 total
Time:        11.5 s
```

### Manual smoke (notification microservice live)

```
$ node dist/apps/notification-microservice/main.js &
[notification-microservice] Notification Microservice is listening for messages

$ node /tmp/publish-test.js
# emits retail.order.created with orderId=9001, customerId=1
[ClientProxy] Successfully connected to RMQ broker
published; sleeping 1s for consumer to ack

# notification microservice stdout:
[notification-microservice] Dispatching order-created notification
    context:        "SendOrderNotificationUseCase"
    correlationId:  "manual-smoke-1"
    orderId:        9001
    customerId:     1
[notification-microservice] Notification dispatched
    context:        "LogNotifierAdapter"
    recipient:      "customer:1"
    channel:        "log"
    subject:        "Order 9001 received"
    body:           "Order 9001 for customer 1 is now pending. Items: 1."
    metadata:       { orderId: 9001, customerId: 1, status: "pending", productCount: 1, occurredAt: "..." }
```

All seven verification gates pass.

## 7. ADR numbers assigned

- **ADR-011** — NotifierPort and the notification microservice as the
  per-module template. Status: Accepted. CLAUDE.md's "next free ADR"
  counter advanced to **012**.

## 8. Suggested adjustments to task-08 (inventory microservice)

1. **Publisher port for events.** When inventory reshapes, the new
   `application/ports/` should include an `IInventoryEventPublisherPort`
   alongside the existing inbound ports. The adapter under
   `infrastructure/messaging/` wraps `ClientProxy.emit()` and does the
   `firstValueFrom` dance internally — application code calls
   `await publisher.emitStockLow(event)` and never touches RxJS. This
   prevents the cold-observable gotcha found in task-07 §5 #3.

2. **Decide where the low-stock threshold lives.** The notification
   side expects `quantity` and `threshold` on the wire (see
   `IInventoryStockLowEvent`). Today there is no threshold persisted
   anywhere in the inventory schema — it's an emit-time decision. Options:
   (a) a constant in `app/config/`, (b) a column on `product_stock`,
   (c) a `LOW_STOCK_THRESHOLD` env var. Pick one in task-08 and document
   the rationale in the inventory ADR.

3. **`occurredAt` on events.** ISO-string format on the wire (see the
   contract). The publisher should set it; consumers must not synthesise
   a fallback (it's required, not optional). When the publisher port is
   built, have it default `occurredAt: new Date().toISOString()` at the
   adapter boundary so use-cases don't have to thread `Date`.

4. **Routing-keys spec lockstep.** `libs/messaging/spec/routing-keys.constants.spec.ts`
   already asserts pattern-enum / constants agreement for all current
   keys. Task-08 doesn't add new keys (the producers are wiring the
   existing `INVENTORY_STOCK_LOW`), so no spec change should be needed
   there — verify by reading.

5. **Reuse the consumer module's shape verbatim.** The inventory
   microservice has multiple bounded contexts already (order, product,
   stock). Each becomes its own `modules/<bc>/` with the same six-folder
   split. See task-07 §2 above for the copy-pasteable template.

6. **`PinoLogger.assign` gotcha.** Inventory's existing services use
   `PinoLogger` without `assign` — they're already correct. The gotcha
   only bites when reshaping a use case that currently runs under HTTP
   scope to also run under an `@EventPattern`. If a use case is shared
   between HTTP and RMQ paths (none today), it must not call `assign`.

7. **`InventoryEventsConsumer` already exists in the notification
   microservice.** Subscribers' side. The inventory microservice needs
   the OUTbound side: a publisher class that emits `inventory.stock.low`
   on `LowStockDetected` domain events. Don't duplicate the routing-key
   constant — import `ROUTING_KEYS.INVENTORY_STOCK_LOW` from
   `@retail-inventory-system/messaging`.

## 9. Open follow-ups (post-task-07)

1. **Real publishers for `retail.order.created` and `inventory.stock.low`.**
   Sequenced as task-09 / task-08 respectively. Until then the consumer
   path is exercised only by the synthetic-publish smoke test.
2. **`EmailNotifierAdapter`** — needs an SMTP transport choice
   (nodemailer / Postmark / SES) plus per-environment credentials, plus
   a templating decision (handlebars / mjml / inline). Out of scope for
   the migration.
3. **`WebhookNotifierAdapter`** — needs retry policy + signed payloads
   (HMAC over body with a per-consumer secret) + a dead-letter strategy
   on persistent failure. Out of scope.
4. **`notification.health.ping` is not yet proxied through the gateway.**
   When a `GET /health/notification` is requested, mount a gateway-side
   pipe that forwards to the RMQ pattern.
5. **Login alerts via the notification microservice.** Carryover-06 §10
   #1 raised this; deferred. To enable: add an `auth.user-logged-in`
   routing key, emit from `LoginUseCase` on the gateway, add a
   `send-login-alert.use-case.ts` in the notification module.
6. **Topic-exchange migration.** The `EXCHANGES.NOTIFICATION` constant
   in `libs/messaging` is reserved but unused; today the
   `notification_events` queue is bound to the default exchange. A
   topic-exchange migration would let multiple consumers fan-out off a
   single emit, but is unnecessary for the current single-consumer
   architecture.
