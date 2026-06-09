---
epic: epic-05
task_number: 8
title: Repoint the notification consumer to retail.order.placed
depends_on: [1, 2, 3, 4, 5, 6, 7]
doc_deliverable: docs/implementation/05-cart-order-payment-walking-skeleton/09-routing-keys-retired-and-added.md
---

# Task 08 — Repoint the notification consumer to `retail.order.placed`

## Required reading

- Review and follow the guidelines in the file `tmp/tasks/execution-requirements.md`.
- Review and follow the carryover documents (`carryover-*.md` in this task's
  folder) produced by the preceding tasks.
- Review the document `tmp/adr-summary.md`, then select, review, and follow the
  `docs/adr/` documents related to this task.

Most relevant: **ADR-011** (the notification microservice is the canonical per-module
template; RMQ subscribers live under `infrastructure/consumers/`; log `correlationId`
inline in `@EventPattern` handlers; cross-service wire events are plain
`ICorrelationPayload` interfaces — never serialize a `DomainEvent` subclass),
**ADR-008/ADR-020** (`retail.order.placed` is emitted onto `notification_events`; the
default exchange binds the queue), **ADR-028** (`retail.order.placed` **replaces** the
retired `retail.order.created`).

## Goal

Restore the order-placed notification leg of the system, repointed onto the new
`retail.order.placed` event (the legacy `retail.order.created` consumer + use case
were deleted during the teardown). Re-create the consumer + the send-notification use
case against `IRetailOrderPlacedEvent`, re-register them, and re-add the notification
e2e. This keeps the notification chain unbroken across the order-model rebuild — no
deferral to a separate notification capability.

## Entry state assumed

- task-01–07 complete. The order chain works end-to-end and emits `retail.order.placed`
  onto `notification_events` (`IRetailOrderPlacedEvent{ orderId, orderNumber,
  customerId, grandTotalMinor, currency, lineCount, eventVersion:'v1', occurredAt,
  correlationId }` in `libs/contracts/retail/events/`). The `RETAIL_ORDER_PLACED`
  routing key exists.
- The notification microservice currently has **no** order consumer (task-01 deleted
  `order-events.consumer.ts` + `SendOrderNotificationUseCase` + their specs and
  unregistered them). The `inventory-events.consumer.ts` (low-stock) +
  `SendLowStockAlertUseCase` are intact. The `Notification` VO + `NotificationChannelEnum`
  + `NOTIFIER` (`LogNotifierAdapter` default) are intact. `test/notification.e2e-spec.ts`
  was deleted in task-01.

## What to build

- **`SendOrderNotificationUseCase`**
  (`apps/notification-microservice/src/modules/notifications/application/use-cases/send-order-notification.use-case.ts`)
  — consumes `IRetailOrderPlacedEvent`; builds a `Notification`
  (`channel: NotificationChannelEnum.LOG`, `recipient: 'order:' + event.orderId`,
  `subject`/`body` referencing `orderNumber` + `grandTotalMinor` + `currency` +
  `lineCount`, `metadata` carrying the event fields + `occurredAt`); logs
  `correlationId` inline; calls `NOTIFIER.send(...)`. (Re-create from scratch against
  the new payload — do not resurrect the old `IRetailOrderCreatedEvent` shape, which
  carried `status` + `products[]`.)
- **`OrderEventsConsumer`**
  (`.../infrastructure/consumers/order-events.consumer.ts`) — `@EventPattern(
  ROUTING_KEYS.RETAIL_ORDER_PLACED)` → `SendOrderNotificationUseCase.execute(event)`.
- Re-register the use case (provider) + consumer (controller) in
  `notifications.module.ts`; re-export from the `consumers` + `use-cases` barrels.

## Files to add

- `apps/notification-microservice/src/modules/notifications/application/use-cases/send-order-notification.use-case.ts`
  (+ `spec/send-order-notification.use-case.spec.ts`)
- `apps/notification-microservice/src/modules/notifications/infrastructure/consumers/order-events.consumer.ts`
- `test/notification.e2e-spec.ts` (re-added — see Tests)
- `docs/implementation/05-cart-order-payment-walking-skeleton/09-routing-keys-retired-and-added.md`

## Files to modify

- `apps/notification-microservice/.../infrastructure/notifications.module.ts` —
  register the consumer (controller) + use case (provider).
- `.../infrastructure/consumers/index.ts`, `.../application/use-cases/index.ts` (+
  `spec/test-doubles.ts` if the order notification spec needs a `NOTIFIER` double).

## Files to delete

None.

## Tests

- **Unit** (`yarn test:unit`):
  - `send-order-notification.use-case.spec.ts` — given an `IRetailOrderPlacedEvent`,
    `NOTIFIER.send` is called with a `Notification` whose `subject`/`body`/`metadata`
    carry the `orderNumber` + `orderId` + totals; `correlationId` is logged. Use a
    `NOTIFIER` double (mirror `send-low-stock-alert.use-case.spec.ts`).
- **E2E** (`yarn test:e2e`) `test/notification.e2e-spec.ts` — re-add it modelled on
  the prior (deleted) order spec and the live `inventory-events` flow: boot the
  notification microservice on `notification_events`, spy on
  `LogNotifierAdapter.prototype.send`, publish a synthetic `retail.order.placed`
  (`IRetailOrderPlacedEvent`) onto the queue via a `ClientProxy`, and assert
  `NOTIFIER.send` fires with the order metadata. (This proves the re-point in
  isolation; the full gateway→retail→notification path is also exercised by
  `cart-to-order-walking-skeleton.e2e-spec.ts`.)

## Doc deliverable

`09-routing-keys-retired-and-added.md` — the **old-vs-new routing-key table**: the
six retired `retail.order.*` keys (`create`/`confirm`/`get`/`created`/`confirmed`/
`cancelled`) and the new key set (`retail.cart.{create,get,add-line,
change-line-quantity,remove-line,claim,created,line-added,line-removed,
line-quantity-changed}`, `retail.cart.place`, `retail.order.{placed,get,list}`,
`retail.payment.{capture,authorized,captured}`), each annotated RPC-vs-event and
with its queue (RPC + `retail.order.placed` involve `notification_events` /
`retail_queue` / `catalog_queue` as applicable; the reserved events sit on
`retail_queue`); and the **consumer re-point** (`retail.order.created` →
`retail.order.placed`, done inline, keeping the notification chain unbroken). Cross-link
`docs/adr/028-…md`, `docs/adr/008-…md`. Describe everything by capability — never by
an epic/task number.

## Carryover to read

`carryover-01.md` … `carryover-07.md`.

## Carryover to produce

Write `carryover-08.md`. Capture: the re-created `SendOrderNotificationUseCase` +
`OrderEventsConsumer` against `retail.order.placed` / `IRetailOrderPlacedEvent`; the
re-added `test/notification.e2e-spec.ts`; that the notification chain is whole again.
Note the only remaining work is task-09 (example-cart seed, doc `10`, README/CLAUDE
full pass, architecture-lint fixtures, final grep). List verify commands.

## Exit criteria

- [ ] The notification microservice consumes `retail.order.placed` and dispatches an
      order-placed notification via the default `LogNotifierAdapter`; the low-stock
      consumer is untouched.
- [ ] `yarn lint` passes (`--max-warnings 0`); `yarn test:unit` + `yarn test:e2e`
      pass (re-added `notification.e2e` green; `cart-to-order-walking-skeleton` shows
      the notification leg firing end-to-end).
- [ ] `09-routing-keys-retired-and-added.md` is written.
- [ ] The self-containment grep is clean.
- [ ] `carryover-08.md` is written.
