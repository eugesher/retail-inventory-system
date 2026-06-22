import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailOrderCancelledEvent } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { RenderAndDispatchUseCase } from '../../application/use-cases';
import { dispatchCustomerEmailNotification } from './dispatch-customer-email';

// Consumes `retail.order.cancelled` off `notification_events` and routes it through the
// template-driven `RenderAndDispatchUseCase` (ADR-033) — the buyer-facing cancellation
// confirmation. The reference is the `orderId` (the `order` reference type).
//
// IMPORTANT — this is the NOTIFICATION-side consumer on `notification_events`. It is a
// distinct concern from the retail-side auto-refund `OrderCancelledConsumer`, which lives in
// the **retail** microservice on `retail_queue` and issues the refund. `retail.order.cancelled`
// is dual-emitted (ADR-033): `retail_queue` drives the refund, `notification_events` drives
// this confirmation. They never collide — different services, different queues.
//
// The cancelled wire contract carries the buyer's resolved `customerEmail` but NOT a
// `customerId`, so `recipientCustomerId` is `null` — this row is not deduped (ADR-033's
// null-recipient rule). A `null` email warn-logs and skips in the shared helper.
// `correlationId` is logged inline (ADR-011 §7).
@Controller()
export class OrderCancelledNotificationConsumer {
  constructor(
    private readonly renderAndDispatch: RenderAndDispatchUseCase,
    @InjectPinoLogger(OrderCancelledNotificationConsumer.name)
    private readonly logger: PinoLogger,
  ) {}

  @EventPattern(ROUTING_KEYS.RETAIL_ORDER_CANCELLED)
  public async onCancelled(@Payload() event: IRetailOrderCancelledEvent): Promise<void> {
    await dispatchCustomerEmailNotification(this.renderAndDispatch, this.logger, {
      eventType: ROUTING_KEYS.RETAIL_ORDER_CANCELLED,
      eventReferenceType: 'order',
      eventReferenceId: String(event.orderId),
      recipientCustomerId: null,
      customerEmail: event.customerEmail,
      context: { ...event },
      correlationId: event.correlationId,
    });
  }
}
