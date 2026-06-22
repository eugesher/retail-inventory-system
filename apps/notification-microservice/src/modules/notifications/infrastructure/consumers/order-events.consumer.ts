import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailOrderPlacedEvent } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { RenderAndDispatchUseCase } from '../../application/use-cases';
import { dispatchCustomerEmailNotification } from './dispatch-customer-email';

// Consumes `retail.order.placed` off `notification_events` and routes it through the
// template-driven `RenderAndDispatchUseCase` (ADR-033): it loads the active
// `retail.order.placed` template, renders it against the event fields, persists a `queued`
// delivery BEFORE the `NOTIFIER` call, then flips the row.
//
// The recipient is the buyer's resolved `customerEmail` (carried on the event,
// producer-side, ADR-033) — a `null` email means a tombstoned/guest customer with no
// contact, in which case the shared helper warn-logs and skips. The event also carries the
// buyer's `customerId`, which becomes the dedupe anchor so an at-least-once redelivery is
// collapsed to a no-op. `correlationId` is logged inline (ADR-011 §7).
@Controller()
export class OrderEventsConsumer {
  constructor(
    private readonly renderAndDispatch: RenderAndDispatchUseCase,
    @InjectPinoLogger(OrderEventsConsumer.name)
    private readonly logger: PinoLogger,
  ) {}

  @EventPattern(ROUTING_KEYS.RETAIL_ORDER_PLACED)
  public async onOrderPlaced(@Payload() event: IRetailOrderPlacedEvent): Promise<void> {
    await dispatchCustomerEmailNotification(this.renderAndDispatch, this.logger, {
      eventType: ROUTING_KEYS.RETAIL_ORDER_PLACED,
      eventReferenceType: 'order',
      eventReferenceId: String(event.orderId),
      recipientCustomerId: event.customerId,
      customerEmail: event.customerEmail,
      context: { ...event },
      correlationId: event.correlationId,
    });
  }
}
