---
epic: epic-05
task_number: 11
title: Re-point notification's `order-events.consumer.ts` to `retail.order.placed`
depends_on: [06]
doc_deliverable: docs/implementation/epic-05-cart-order-payment-walking-skeleton/09-routing-keys-retired-and-added.md (consumer half — completes the file)
---

# Task 11 — Re-point the notification order-events consumer

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** [ADR-001](../../docs/adr/001-structured-logging-with-pino.md) (inside `@EventPattern` handlers `correlationId` is logged inline, not via `.assign()` — important since the consumer is event-pattern-scoped), [ADR-011](../../docs/adr/011-notifier-port-and-adapters.md) (the notification microservice's canonical per-module template; the consumer subscriber lives at `infrastructure/consumers/`, not `presentation/`), [ADR-008](../../docs/adr/008-rabbitmq-via-libs-messaging.md) (the routing-key constants are the only correct reference; the literal `'retail.order.created'` from task-06's transitional state must go).

## Goal

Re-point the notification microservice's `order-events.consumer.ts` from the retired `retail.order.created` to the new `retail.order.placed`. The consumer was subscribed to `retail.order.created` until task-06 removed the routing-key constant and forced the file to reference the literal `'retail.order.created'` with a TODO. This task replaces the literal with `ROUTING_KEYS.RETAIL_ORDER_PLACED` and updates:

- The payload shape (the consumer was decoding `IOrderCreatedEvent`; the new payload is `IOrderPlacedEvent` — different fields).
- The use case behind the consumer — `SendOrderNotificationUseCase` (epic-01 + ADR-011) — to accept the new payload shape.
- The consumer spec.

The single producer (the deleted legacy publisher in task-01) is gone. The only producer of `retail.order.placed` is task-06's new `OrderRabbitmqPublisher`. The chain is unbroken once this task lands.

## Entry state assumed

Task-06 carryover present:

- `ROUTING_KEYS.RETAIL_ORDER_PLACED` exists.
- `IOrderPlacedEvent` interface exists in `libs/contracts/retail/orders/events/`.
- The retail-microservice emits `retail.order.placed` on Place Order.
- The notification's consumer file still references the literal `'retail.order.created'` with the task-06 TODO comment.

Task-12 (closeout) will extend the architecture-lint fixture to confirm the consumer-side ban on string-literal routing keys; this task pre-empts the lint by replacing the literal here.

## Scope

**In:**

- Update `apps/notification-microservice/src/modules/notifications/infrastructure/consumers/order-events.consumer.ts`:
  - Replace the `@EventPattern('retail.order.created')` decorator with `@EventPattern(ROUTING_KEYS.RETAIL_ORDER_PLACED)`.
  - Replace the payload type annotation `IOrderCreatedEvent` with `IOrderPlacedEvent`.
  - Update the handler body — the new payload has `orderId`, `orderNumber`, `customerId`, `grandTotalMinor`, `currency`, `lineCount`, `correlationId`. Whatever the previous handler did with `IOrderCreatedEvent`'s fields, port it to the new fields. (Specifically: the legacy payload was `{ orderId, customerId, totalAmount, correlationId }`; the new payload renames `totalAmount` to `grandTotalMinor` and adds `orderNumber` + `lineCount`. The consumer was likely passing `totalAmount` into `SendOrderNotificationUseCase`; the use case's interface needs to accept `grandTotalMinor` instead, OR the consumer maps the field at the boundary.)
- Update `SendOrderNotificationUseCase` to accept the new payload fields. The use case lives at `apps/notification-microservice/src/modules/notifications/application/use-cases/send-order-notification.use-case.ts` (verify the path; ADR-011 names the file). The signature change is a renamed parameter — the implementer picks the path:
  1. **Rename** the use case's payload field from `totalAmount` to `grandTotalMinor`. (Cleanest — matches the new wire shape.)
  2. **Map** at the consumer (consumer extracts fields and passes positional). (Cleaner boundary — but adds a layer.)
  - The doc deliverable cites whichever path was chosen.
- Update the consumer's spec at `apps/notification-microservice/.../infrastructure/consumers/spec/order-events.consumer.spec.ts`:
  - Replace `IOrderCreatedEvent` test fixtures with `IOrderPlacedEvent` shapes.
  - The mock payload includes `orderNumber` and `lineCount`.
  - Assert the use case is called with the right field mapping (per the path chosen above).
- Update the use case spec at `apps/notification-microservice/.../application/use-cases/spec/send-order-notification.use-case.spec.ts` for the renamed field (path 1) or leave untouched (path 2).
- **Delete the task-06 transitional literal.** After this task, no file in `apps/notification-microservice/` or anywhere else references `'retail.order.created'` as a literal. `grep -rE "['\"]retail\.order\.created['\"]" apps libs` returns zero matches.
- Doc deliverable: append the consumer-side section to `09-routing-keys-retired-and-added.md` (task-06 wrote the table half).

**Out:**

- Subscribing to other new keys (`retail.cart.created`, `retail.payment.captured`, etc.) — `epic-10` owns the broader consumer fan-out.
- The `inventory.stock.low` consumer (epic-04's `low-stock-events.consumer.ts`) — untouched. The epic explicitly preserves it.

## `order-events.consumer.ts` shape

```ts
import { Controller, Inject } from '@nestjs/common';
import { Ctx, EventPattern, Payload, RmqContext } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ROUTING_KEYS } from '@retail-inventory-system/messaging';
import { IOrderPlacedEvent } from '@retail-inventory-system/contracts';

import { SendOrderNotificationUseCase } from '../../application/use-cases';

@Controller()
export class OrderEventsConsumer {
  constructor(
    private readonly sendNotification: SendOrderNotificationUseCase,
    @InjectPinoLogger(OrderEventsConsumer.name) private readonly logger: PinoLogger,
  ) {}

  @EventPattern(ROUTING_KEYS.RETAIL_ORDER_PLACED)
  public async handleOrderPlaced(
    @Payload() payload: IOrderPlacedEvent,
    @Ctx() context: RmqContext,
  ): Promise<void> {
    // ADR-001 + ADR-011 §7: log correlationId inline; never use PinoLogger.assign() here.
    this.logger.info(
      {
        correlationId: payload.correlationId,
        orderId: payload.orderId,
        orderNumber: payload.orderNumber,
        customerId: payload.customerId,
        grandTotalMinor: payload.grandTotalMinor,
        currency: payload.currency,
        lineCount: payload.lineCount,
      },
      'Received retail.order.placed',
    );

    await this.sendNotification.execute({
      orderId: payload.orderId,
      orderNumber: payload.orderNumber,
      customerId: payload.customerId,
      grandTotalMinor: payload.grandTotalMinor,
      currency: payload.currency,
      lineCount: payload.lineCount,
      correlationId: payload.correlationId,
    });

    // The RmqContext's channel.ack(...) is handled by Nest's RMQ transport
    // automatically when the handler resolves; we do NOT manually ack here
    // (unless the project has switched to manual ack — verify against the
    // existing low-stock consumer for the project's chosen pattern).
  }
}
```

## Files to modify

- `apps/notification-microservice/src/modules/notifications/infrastructure/consumers/order-events.consumer.ts`
- `apps/notification-microservice/src/modules/notifications/infrastructure/consumers/spec/order-events.consumer.spec.ts`
- `apps/notification-microservice/src/modules/notifications/application/use-cases/send-order-notification.use-case.ts` (if path 1 chosen)
- `apps/notification-microservice/src/modules/notifications/application/use-cases/spec/send-order-notification.use-case.spec.ts` (if path 1 chosen)

## Tests

- `order-events.consumer.spec.ts` — ≥3 cases:
  1. Handler decodes a valid `IOrderPlacedEvent` payload and calls `SendOrderNotificationUseCase.execute` once with the mapped fields.
  2. Handler logs `correlationId` inline (verify via Pino mock that the log call carries the field).
  3. (Optional) Handler does not throw on a malformed payload — instead logs at warn and acks. (Verify project convention; the existing low-stock consumer's error behavior is the reference.)
- `send-order-notification.use-case.spec.ts` — update fixture payloads for the new field shape.
- `yarn lint` passes.
- `yarn build:notification-microservice` succeeds.
- `yarn test:e2e` is NOT run by this task — task-12's e2e covers the end-to-end notification chain.

## Doc deliverable

Append to `docs/implementation/epic-05-cart-order-payment-walking-skeleton/09-routing-keys-retired-and-added.md` the consumer-side section. Task-06 wrote sections 1–2 (retired + added tables); this task adds section 3.

3. **The notification consumer's re-point.** Describe the path:
   - Old subscription: `@EventPattern('retail.order.created')` in `order-events.consumer.ts`; payload `IOrderCreatedEvent`.
   - New subscription: `@EventPattern(ROUTING_KEYS.RETAIL_ORDER_PLACED)`; payload `IOrderPlacedEvent`.
   - Cite the chosen mapping path (rename the use case payload field vs map at the consumer). Explain the trade-off:
     - Path 1 (rename) — cleanest type-level shape, one fewer transformation. Justification: the field `grandTotalMinor` is semantically more precise than `totalAmount`, so the rename aligns the use case with the wire contract.
     - Path 2 (map) — preserves the use case as-is, leaves the wire shape decoupled. Justification: future consumers (audit log, email, webhook) can pass `grandTotalMinor` directly without re-mapping; the consumer-level map is the only translation point.
   - Note that the inline-literal workaround from task-06 is now gone; the lint extension in task-12 enforces this.
   - The `inventory.stock.low` consumer is untouched; the notification chain for low-stock alerts is independent and unchanged.

The completed `09-…md` document now covers retired keys, added keys, and the single consumer change made by this epic.

## Carryover produced (consumed by task-12)

- The notification consumer is subscribed to `retail.order.placed`; the cluster's order-placed → notification chain is unbroken.
- No remaining references to `'retail.order.created'` in any source file.
- Doc `09-routing-keys-retired-and-added.md` complete.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the updated consumer spec and use-case spec green.
- [ ] `yarn build:notification-microservice` succeeds.
- [ ] `grep -rE "['\"]retail\.order\.created['\"]" apps libs` returns zero matches.
- [ ] `yarn start:dev` boots the full stack; placing an order via the api-gateway HTTP endpoint produces a notification microservice log line citing the order placement (verified manually by tailing the notification's stdout).
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc `09-routing-keys-retired-and-added.md` has the consumer-side section (section 3) appended.
