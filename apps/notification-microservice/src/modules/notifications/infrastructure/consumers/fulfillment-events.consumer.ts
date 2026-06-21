import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IRetailFulfillmentDeliveredEvent,
  IRetailFulfillmentShippedEvent,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { RenderAndDispatchUseCase } from '../../application/use-cases';
import { dispatchCustomerEmailNotification } from './dispatch-customer-email';

// Consumes the two fulfillment lifecycle events the retail orders module emits onto
// `notification_events` (the producer-targets-consumer-queue routing, ADR-008/020) and
// routes each through the template-driven `RenderAndDispatchUseCase` (ADR-033). Each
// handler keys its own template (`retail.fulfillment.shipped` / `.delivered`) and reference
// id (`fulfillmentId`); the shared helper owns the missing-recipient skip + the dispatch.
//
// The shipped/delivered wire contracts carry the buyer's resolved `customerEmail` but NOT a
// `customerId`, so `recipientCustomerId` is `null` — these rows are not deduped (ADR-033's
// null-recipient rule). `correlationId` is logged inline (ADR-011 §7).
@Controller()
export class FulfillmentEventsConsumer {
  constructor(
    private readonly renderAndDispatch: RenderAndDispatchUseCase,
    @InjectPinoLogger(FulfillmentEventsConsumer.name)
    private readonly logger: PinoLogger,
  ) {}

  @EventPattern(ROUTING_KEYS.RETAIL_FULFILLMENT_SHIPPED)
  public async onShipped(@Payload() event: IRetailFulfillmentShippedEvent): Promise<void> {
    await dispatchCustomerEmailNotification(this.renderAndDispatch, this.logger, {
      eventType: ROUTING_KEYS.RETAIL_FULFILLMENT_SHIPPED,
      eventReferenceType: 'fulfillment',
      eventReferenceId: String(event.fulfillmentId),
      recipientCustomerId: null,
      customerEmail: event.customerEmail,
      context: { ...event },
      correlationId: event.correlationId,
    });
  }

  @EventPattern(ROUTING_KEYS.RETAIL_FULFILLMENT_DELIVERED)
  public async onDelivered(@Payload() event: IRetailFulfillmentDeliveredEvent): Promise<void> {
    await dispatchCustomerEmailNotification(this.renderAndDispatch, this.logger, {
      eventType: ROUTING_KEYS.RETAIL_FULFILLMENT_DELIVERED,
      eventReferenceType: 'fulfillment',
      eventReferenceId: String(event.fulfillmentId),
      recipientCustomerId: null,
      customerEmail: event.customerEmail,
      context: { ...event },
      correlationId: event.correlationId,
    });
  }
}
