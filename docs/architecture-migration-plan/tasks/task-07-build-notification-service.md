# task-07 — Build Notification service (Phase 4)

## Context

- Migration plan: `docs/architecture-migration-plan/parts/recommendation.md`
- Conventions preamble: `docs/architecture-migration-plan/tasks/task-01-review-project-and-update-plan.md`
- Previous carryover: `docs/architecture-migration-plan/tasks/_carryover-06.md`
- Project conventions: `CLAUDE.md`
- Where we are in the migration: gateway is hexagonal; auth is wired
  end-to-end. The notification microservice
  (`apps/notification-microservice/`) is still a stub: its
  `app.module.ts` registers `ConfigModule` + `LoggerModule` and
  nothing else; `main.ts` connects to the `notification_events`
  RabbitMQ queue but the service has no handlers or business logic.
  This task builds it correctly the first time, establishing the
  per-module template that the bigger services (inventory, retail)
  will follow in tasks 08–09.

## Prerequisites

- [ ] `_carryover-06.md` exists and was read first.
- [ ] Build is green on entry.
- [ ] `@retail-inventory-system/contracts/notification/` and
  `@retail-inventory-system/contracts/retail/` exist from task-03;
  the retail/inventory microservices have **not** yet been
  reshaped, so the events this service will consume
  (`retail.order.created`, `inventory.stock.low`) are not yet
  emitted by anyone. That's fine — task-07 publishes the
  contracts and the consumers; the producers come on stream in
  tasks 08–09. End-to-end verification waits for task-09.

## Goal

Stand up `apps/notification-microservice/` with the canonical
hexagonal layout: a `notifications` module with `domain/`,
`application/` (use cases + `NotifierPort`), `infrastructure/`
(consumers + delivery adapters), and `presentation/` (health/admin
only). At least one adapter (a logging notifier) is wired and
unit-tested. This service becomes the **template** that tasks 08/09
reference when reshaping inventory and retail.

## Steps

1. **Create the module skeleton.**
   `apps/notification-microservice/src/modules/notifications/{application,domain,infrastructure,presentation}/`.

2. **`domain/notification.model.ts`** — pure class with the fields a
   notification needs (recipient, channel, subject, body, metadata).
   No `@nestjs/*`. Validation via the value-object base from
   `@retail-inventory-system/ddd`.

3. **`application/ports/notifier.port.ts`** — interface
   `NotifierPort { send(message: NotificationMessage): Promise<void> }`,
   plus a string DI symbol `NOTIFIER`.

4. **`application/use-cases/`** — at least:
   - `send-order-notification.use-case.ts` — consumes a
     `RetailOrderCreatedEvent` (from
     `@retail-inventory-system/contracts/retail`) and emits a
     notification through `NotifierPort`.
   - `send-low-stock-alert.use-case.ts` — consumes
     `InventoryStockLowEvent` (from
     `@retail-inventory-system/contracts/inventory`).
   If task-06 chose to publish a `UserLoggedIn` event, add a
   `send-login-alert.use-case.ts` here; otherwise skip.

5. **`infrastructure/delivery/`** — adapters implementing
   `NotifierPort`:
   - `log.notifier.adapter.ts` — writes to Pino at `info` level.
     This is the default binding.
   - `email.notifier.adapter.ts` — class scaffold with a `TODO`
     and a method body that throws "not implemented". **Do not**
     add `nodemailer` as a dep yet — defer until SMTP is actually
     wired (post-migration).
   - `webhook.notifier.adapter.ts` — class scaffold with a `TODO`.

6. **`infrastructure/consumers/`** — RabbitMQ subscribers:
   - `order-events.consumer.ts` —
     `@EventPattern('retail.order.created')` (the dotted form if
     task-04 chose to rename, or the existing snake_case enum
     value), invokes `SendOrderNotificationUseCase`.
   - `inventory-events.consumer.ts` —
     `@EventPattern('inventory.stock.low')`, invokes
     `SendLowStockAlertUseCase`.
   Pattern strings come from
   `@retail-inventory-system/messaging` constants — no string
   literals.

7. **`infrastructure/notifications.module.ts`** — wires `NOTIFIER`
   symbol → `LogNotifierAdapter`, registers the consumers, imports
   `MessagingModule` and the `LoggerModule` from
   `@retail-inventory-system/observability`.

8. **`presentation/health.controller.ts`** — minimal health check
   responding to a `notification.health` message pattern. The
   notification microservice is RMQ-only (no HTTP) — health goes
   through the same transport. The gateway can proxy a
   `GET /health/notification` to it later if needed.

9. **Update `apps/notification-microservice/src/main.ts`** to:
   - First line:
     `import '@retail-inventory-system/observability/tracer';`
   - Use `NestFactory.createMicroservice` with the RabbitMQ config
     from `@retail-inventory-system/messaging`. The current
     bootstrapping (using `MicroserviceQueueEnum.NOTIFICATION_EVENTS`)
     stays — only the import path changes.
   - Use `LoggerModule` from
     `@retail-inventory-system/observability`.

10. **Tests.**
    - Unit tests for both use cases with an in-memory `NotifierPort`
      double.
    - Unit test for `LogNotifierAdapter` against Pino's test
      transport.
    - **E2E for full flow** is deferred to task-09 — until retail
      starts publishing `retail.order.created`, no end-to-end
      notification path exists. This task does, however, add a
      smoke test under `test/notification.e2e-spec.ts` (or extend
      the existing `system-api.e2e-spec.ts`) that publishes a
      synthetic `retail.order.created` payload directly to the
      `notification_events` queue and asserts a Pino log line
      containing the order ID.

11. **Update `docker-compose.yml`** so notification depends on
    rabbitmq (it already does — no change required; verify by
    reading the file at task time).

## Documentation updates required

- [ ] `README.md`: extend "Architecture" with a paragraph
  describing the notification service's ports/adapters (and the
  fact that `LogNotifierAdapter` is the default — switching to
  email is just a DI rebind once `EmailNotifierAdapter` is
  implemented).
- [ ] `CLAUDE.md`:
  - Remove the "Notification microservice is a stub" line from
    "Known Issues".
  - Add an explicit note that the notification module is the
    **canonical per-module template** — later services follow
    its shape.
  - Add the `notification` exchange/queue to the "RabbitMQ
    queues" line.
- [ ] `docs/adr/NNN-notifier-port-and-adapters.md`: new ADR.

## Verification

- [ ] `yarn install` succeeds.
- [ ] `yarn build` succeeds for all four apps.
- [ ] `yarn lint` succeeds.
- [ ] `yarn test:unit` succeeds — including the new use-case tests.
- [ ] `yarn test:e2e` succeeds — including the synthetic
  `retail.order.created` publish-and-observe smoke test.
- [ ] Publishing `retail.order.created` to RabbitMQ produces a
  Pino log line with the order ID (manual smoke; raw output in
  carryover).

## Carryover

Write `_carryover-07.md` with:
- The per-module template paths (this is the reference for tasks
  08–09 — make it copy-pasteable).
- Files created.
- Tests added (paths + counts).
- Whether `EmailNotifierAdapter` / `WebhookNotifierAdapter` were
  scaffolded as TODOs or skipped entirely.
- Verification results.
- Suggested adjustments to task-08 (inventory) — particularly any
  contract drift discovered when wiring the consumers.
