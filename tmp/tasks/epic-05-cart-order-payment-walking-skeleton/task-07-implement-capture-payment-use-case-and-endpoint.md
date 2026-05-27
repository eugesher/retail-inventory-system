---
epic: epic-05
task_number: 7
title: Implement Capture Payment use case + endpoint
depends_on: [01, 02, 03, 04, 05, 06]
doc_deliverable: docs/implementation/epic-05-cart-order-payment-walking-skeleton/07-authorize-on-place-capture-explicit-q5.md (capture half — completes the file) + 08-idempotency-key-header-q10.md (capture half)
---

# Task 07 — Implement Capture Payment use case + endpoint

## Required reading

- **Mandatory:** Read `tmp/adr-summary.md` before starting — the index of architectural decisions of record.
- **Recommended:** [ADR-013](../../docs/adr/013-order-aggregate-and-cross-service-confirm.md) (the previous Confirm Order flow that the Capture step is loosely analogous to — the difference is that Capture only touches payment, not inventory), [ADR-020](../../docs/adr/020-rabbitmq-as-inter-service-bus.md) (the publisher port boundary + the post-commit emit + warn-and-swallow contract), [ADR-019](../../docs/adr/019-typeorm-and-mysql-for-persistence.md) (`ITransactionPort` for the payment-capture transaction).

## Goal

`CapturePaymentUseCase` is the explicit-capture operation (Q5). It:

1. Loads the order by id + does owner-check (or admin-role allowance — see §"Owner check vs admin" below).
2. Validates the order has a Payment row in `status='authorized'` (the only legal transition).
3. Calls `PAYMENT_GATEWAY.capture(payment.gatewayReference, optional amountMinor)`.
4. On gateway success: `payment.markCaptured(now)` + `order.markPaymentCaptured()` — both inside one transaction; both saved.
5. Post-commit: emits `retail.payment.captured` via `ORDER_EVENTS_PUBLISHER`.
6. Returns an updated `IPaymentSummaryDto` (the smaller response shape from task-06; the full `IOrderResponseDto` is not returned — the api-gateway controller (task-09) decides whether to re-fetch the order for the HTTP response shape).

The endpoint accepts an optional `amountMinor` body parameter. If absent, the use case captures the full authorized amount. If present, it MUST equal the authorized amount in this epic (partial captures are `epic-09`). The use case asserts the equality and rejects otherwise. The doc deliverable explicitly cites the future partial-capture path.

Open Question Q10 again: the `Idempotency-Key` header is accepted on the request payload but NOT enforced. The use case logs it; `epic-12` adds dedupe. Calling Capture twice with the same key today produces:

- First call: gateway call succeeds, Payment flips `authorized` → `captured`, Order flips, event emitted.
- Second call: the use case detects `payment.status === 'captured'` (the precondition check), rejects with `'Payment already captured'`. The gateway is NOT called a second time (the precondition check guards it). The doc explains: this idempotency-at-the-state-level is incidental, not the same as the Idempotency-Key dedupe `epic-12` will provide — the spec asserts that two identical Capture calls return different outcomes (success then 409), which is the marker of "Idempotency-Key dedupe is not enforced yet".

## Entry state assumed

Task-06 carryover present:

- `PlaceOrderUseCase` ships orders with `paymentStatus=authorized` and a Payment row.
- `ORDER_EVENTS_PUBLISHER` wired; `emitPaymentCaptured(...)` is on the interface (task-06's port file declared it; this task adds the implementation).
- `Order.markPaymentCaptured()` exists; `Payment.markCaptured(at)` exists.
- The new `retail.payment.authorized` constant lands; `retail.payment.captured` does NOT yet exist — this task adds it.
- `OrdersController` has the `RETAIL_ORDER_PLACE` handler; this task adds the capture handler.

## Scope

**In:**

- New use case `apps/retail-microservice/src/modules/orders/application/use-cases/capture-payment.use-case.ts` + spec.
- New routing-key constants:
  - `RETAIL_ORDER_CAPTURE = 'retail.order.capture'` — RPC.
  - `RETAIL_PAYMENT_CAPTURED = 'retail.payment.captured'` — event.
- New wire DTO `libs/contracts/retail/payment/dto/capture-payment-request.dto.ts`:
  ```ts
  export interface ICapturePaymentRequest {
    orderId: number;
    amountMinor?: number; // must equal the authorized amount in this epic
    idempotencyKey?: string;
    currentUser?: ICurrentUser; // forwarded by the api-gateway pipe
    correlationId?: string;
  }
  ```
- New event interface `libs/contracts/retail/payment/events/payment-captured.event.ts` — was reserved by task-04; this task fills it (the wire interface itself).
- Update `OrderRabbitmqPublisher` (task-06 wrote the file) to implement `emitPaymentCaptured(...)`.
- New presentation handler in `apps/retail-microservice/src/modules/orders/presentation/orders.controller.ts`: `@MessagePattern(ROUTING_KEYS.RETAIL_ORDER_CAPTURE)` handler that delegates to `CapturePaymentUseCase`.
- Update `orders.module.ts` provider list to add `CapturePaymentUseCase`.
- Doc deliverable: append the capture half to `07-authorize-on-place-capture-explicit-q5.md` + the capture half to `08-idempotency-key-header-q10.md`.

**Out:**

- Partial captures — `epic-09`.
- Refund / void — `epic-09`.
- The api-gateway-side `POST /api/orders/:id/payments/capture` endpoint — task-09.
- Ship-triggered automatic capture — `epic-08`.

## Owner check vs admin

The epic's API table shows the Capture endpoint as bearer (`order:capture` OR system). The system path is for the automatic capture in `epic-08`; this epic ships only the user-or-admin path. The owner check is:

- If `currentUser.roles` contains `'admin'` or `'order-support'` or the permission `'order:capture'` is granted: allowed.
- Else: `cart.customerId === currentUser.id` is required (i.e. customers can capture their own orders' payments).

This matches the read-side rule (task-08) — owner-check at the use case layer, with admin override via permission codes.

## `CapturePaymentUseCase` shape

```ts
import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { ITransactionPort, TRANSACTION_PORT } from '@retail-inventory-system/database';
import {
  ICapturePaymentRequest,
  ICurrentUser,
  IPaymentSummaryDto,
} from '@retail-inventory-system/contracts';

import {
  IOrderEventsPublisherPort,
  IOrderRepositoryPort,
  IPaymentGatewayPort,
  IPaymentRepositoryPort,
  ORDER_EVENTS_PUBLISHER,
  ORDER_REPOSITORY,
  PAYMENT_GATEWAY,
  PAYMENT_REPOSITORY,
} from '../ports';

@Injectable()
export class CapturePaymentUseCase {
  constructor(
    @Inject(ORDER_REPOSITORY) private readonly orders: IOrderRepositoryPort,
    @Inject(PAYMENT_REPOSITORY) private readonly payments: IPaymentRepositoryPort,
    @Inject(PAYMENT_GATEWAY) private readonly gateway: IPaymentGatewayPort,
    @Inject(ORDER_EVENTS_PUBLISHER) private readonly publisher: IOrderEventsPublisherPort,
    @Inject(TRANSACTION_PORT) private readonly tx: ITransactionPort,
    @InjectPinoLogger(CapturePaymentUseCase.name) private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: ICapturePaymentRequest): Promise<IPaymentSummaryDto> {
    if (payload.idempotencyKey) {
      this.logger.info(
        { correlationId: payload.correlationId, orderId: payload.orderId, idempotencyKey: payload.idempotencyKey },
        'Idempotency-Key received (not yet enforced — see epic-12)',
      );
    }

    // Pre-tx reads.
    const order = await this.orders.findById(payload.orderId);
    if (!order) throw new Error(`Order ${payload.orderId} not found`);
    this.assertCanCapture(order, payload.currentUser);

    const payment = await this.payments.findByOrderId(order.id!);
    if (!payment) throw new Error(`Order ${order.id} has no Payment row`);
    if (payment.status !== 'authorized') {
      throw new Error(`Cannot capture from ${payment.status}; expected authorized`);
    }
    if (payload.amountMinor !== undefined && payload.amountMinor !== payment.amountMinor) {
      throw new Error(
        `Partial captures are not supported (epic-09). Requested ${payload.amountMinor}, authorized ${payment.amountMinor}.`,
      );
    }

    // Call the gateway. (See task-06's "Gateway-inside-tx tradeoff" — for the
    // fake adapter, inside-tx is fine; the real adapter will need the
    // two-transaction reshape.)
    const result = await this.gateway.capture({
      gatewayReference: payment.gatewayReference,
      amountMinor: payment.amountMinor,
      idempotencyKey: payload.idempotencyKey,
      correlationId: payload.correlationId,
    });
    if (result.status !== 'captured') {
      throw new Error(`Gateway capture returned non-success: ${result.status}`);
    }

    const updatedPayment = await this.tx.runInTransaction(async (scope) => {
      const now = new Date();
      payment.markCaptured(now);
      order.markPaymentCaptured();
      await this.payments.save(payment, scope);
      await this.orders.save(order, scope);
      return payment;
    });

    // Post-commit: emit.
    await this.publisher.emitPaymentCaptured({
      orderId: order.id!,
      paymentId: updatedPayment.id!,
      amountMinor: updatedPayment.amountMinor,
      currency: updatedPayment.currency,
      eventVersion: 'v1',
      occurredAt: new Date().toISOString(),
      correlationId: payload.correlationId,
    });

    this.logger.info(
      {
        correlationId: payload.correlationId,
        orderId: order.id,
        paymentId: updatedPayment.id,
        amountMinor: updatedPayment.amountMinor,
      },
      'Payment captured',
    );

    return this.toPaymentSummaryDto(updatedPayment);
  }

  private assertCanCapture(order: { customerId: string }, currentUser?: ICurrentUser): void {
    if (!currentUser) throw new Error('Authentication required');
    const isAdmin =
      currentUser.roles?.includes('admin') ||
      currentUser.roles?.includes('order-support') ||
      currentUser.permissions?.includes('order:capture');
    if (isAdmin) return;
    if (order.customerId !== currentUser.id) {
      throw new Error('You may only capture payment for your own orders');
    }
  }

  private toPaymentSummaryDto(payment: Payment): IPaymentSummaryDto { /* … */ }
}
```

## `OrderRabbitmqPublisher` update

Task-06 wrote the file with `emitPlaced` and `emitPaymentAuthorized`. This task adds `emitPaymentCaptured`:

```ts
public async emitPaymentCaptured(event: IPaymentCapturedEvent): Promise<void> {
  try {
    await firstValueFrom(this.client.emit(ROUTING_KEYS.RETAIL_PAYMENT_CAPTURED, event));
  } catch (err) {
    this.logger.warn(
      { correlationId: event.correlationId, orderId: event.orderId, err },
      'Failed to publish retail.payment.captured',
    );
  }
}
```

Note the warn-and-swallow shape (ADR-013): the Payment is captured (DB row is `captured`); a failed post-commit publish becomes a notification gap, not a data inconsistency. The doc forward-links to `epic-12`'s outbox for the durability fix.

## `orders.controller.ts` update

```ts
@MessagePattern(ROUTING_KEYS.RETAIL_ORDER_CAPTURE)
public async handleCapture(@Payload() payload: ICapturePaymentRequest): Promise<IPaymentSummaryDto> {
  return this.capturePayment.execute(payload);
}
```

The controller constructor adds `private readonly capturePayment: CapturePaymentUseCase`.

## Files to add

- `apps/retail-microservice/src/modules/orders/application/use-cases/capture-payment.use-case.ts`
- `apps/retail-microservice/src/modules/orders/application/use-cases/spec/capture-payment.use-case.spec.ts`
- `libs/contracts/retail/payment/dto/capture-payment-request.dto.ts`

## Files to modify

- `apps/retail-microservice/src/modules/orders/application/use-cases/index.ts` — re-export `CapturePaymentUseCase`.
- `apps/retail-microservice/src/modules/orders/infrastructure/orders.module.ts` — provider list extended with `CapturePaymentUseCase`.
- `apps/retail-microservice/src/modules/orders/infrastructure/messaging/order-rabbitmq.publisher.ts` — implement `emitPaymentCaptured`.
- `apps/retail-microservice/src/modules/orders/infrastructure/messaging/spec/order-rabbitmq.publisher.spec.ts` — add the test case.
- `apps/retail-microservice/src/modules/orders/presentation/orders.controller.ts` — add the `@MessagePattern(RETAIL_ORDER_CAPTURE)` handler.
- `libs/messaging/routing-keys.constants.ts` — add `RETAIL_ORDER_CAPTURE`, `RETAIL_PAYMENT_CAPTURED`.
- `libs/messaging/spec/routing-keys.constants.spec.ts` — update the agreement assertions.
- `libs/contracts/microservices/microservice-message-pattern.enum.ts` — add the two new entries.
- `libs/contracts/retail/payment/events/payment-captured.event.ts` — fill in the interface (task-04 reserved the filename).
- `libs/contracts/retail/payment/index.ts` — re-export the new DTO.
- `apps/retail-microservice/src/modules/orders/application/ports/order-events-publisher.port.ts` — `emitPaymentCaptured` was on the interface from task-06; verify and re-export if needed.

## Tests

- `capture-payment.use-case.spec.ts` — ≥8 cases:
  1. Happy path: order with `paymentStatus=authorized` and Payment in `authorized` → after execute, both are `captured`, event emitted once.
  2. Non-existent order rejects.
  3. Order has no Payment row rejects (defensive — should not happen post-task-06).
  4. Payment in `none` rejects.
  5. Payment in `captured` already rejects (the second-call-with-same-Idempotency-Key marker case).
  6. Partial amount rejects (`amountMinor !== authorized.amountMinor`).
  7. Cross-customer non-admin rejects.
  8. Admin user can capture any order's payment.
  9. Gateway non-success result surfaces as a rejection (the order stays in `authorized` — no half-state).
  10. `Idempotency-Key` header is logged but does not change behavior.
- `order-rabbitmq.publisher.spec.ts` — extend with the captured-emit test: routes to `RETAIL_PAYMENT_CAPTURED`; publish failure warn-and-swallows.
- `yarn lint` passes.
- `yarn build:retail-microservice` succeeds.

## Doc deliverable

### Append to `07-authorize-on-place-capture-explicit-q5.md` (target +60 lines)

Sections (this task adds 4, 5):

4. **The Capture endpoint.** A dedicated RPC (`RETAIL_ORDER_CAPTURE`) and HTTP route (`POST /api/orders/:id/payments/capture` — task-09 wires the HTTP side). Why a dedicated endpoint instead of "PATCH /api/orders/:id with `paymentStatus=captured`": the semantic of "capture" is "perform the gateway call now"; a status-update PATCH would not convey "make the network call". The Capture endpoint is a verb-resource, not a noun-resource, and the project's REST conventions allow this for explicit imperatives.
5. **The future ship-triggered automatic capture.** `epic-08`'s ship event triggers an internal Capture call (from the system actor, no HTTP). The same use case will be invoked — no rewrite needed; the `currentUser` becomes a service-account user with the `order:capture` permission. The doc names this forward-link explicitly.

### Append to `08-idempotency-key-header-q10.md` (target +30 lines)

Section (this task adds 3; task-12 final-passes):

3. **Capture's accept-but-don't-enforce.** Same shape as Place Order's header acceptance. The `idempotencyKey` is logged inside the use case; not stored. The marker test (calling Capture twice with the same key) is included in the spec — the second call returns 409 because the precondition check fires (`payment.status === 'captured'`), not because the Idempotency-Key was matched. The doc explains that the state-machine guard happens to be idempotent for this transition, which is a property of the domain model, not of the Idempotency-Key system. `epic-12` will add a separate dedupe layer that returns 200 (with the cached response body) instead of 409 on the second call.

## Carryover produced (consumed by task-08 onward)

- `CapturePaymentUseCase` on disk + spec green.
- New routing-key constants (`RETAIL_ORDER_CAPTURE`, `RETAIL_PAYMENT_CAPTURED`).
- `OrderRabbitmqPublisher.emitPaymentCaptured` implemented.
- `OrdersController` has the second handler (`RETAIL_ORDER_CAPTURE`); task-08 adds the get + list handlers.
- Capture-side DTOs filled.
- Doc 07 complete; doc 08 has the capture half.

## Exit criteria

- [ ] `yarn lint` passes (`--max-warnings 0`).
- [ ] `yarn test:unit` passes; the capture-payment spec (≥8 cases) green; the publisher-spec extension green.
- [ ] `yarn build:retail-microservice` succeeds.
- [ ] `yarn start:dev:retail-microservice` boots; a `rabbitmqadmin publish` against `retail.order.capture` with a placed-order id returns an `IPaymentSummaryDto` with `status='captured'`.
- [ ] RabbitMQ shows `retail.payment.captured` published after the call.
- [ ] No file outside `tmp/` references `tmp/`.
- [ ] Doc 07 (complete), doc 08 (capture half) exist.
