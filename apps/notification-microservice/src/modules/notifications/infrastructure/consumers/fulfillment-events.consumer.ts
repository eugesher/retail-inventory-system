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
