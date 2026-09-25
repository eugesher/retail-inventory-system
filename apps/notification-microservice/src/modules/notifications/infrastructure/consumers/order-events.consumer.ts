import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailOrderPlacedEvent } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { RenderAndDispatchUseCase } from '../../application/use-cases';
import { dispatchCustomerEmailNotification } from './dispatch-customer-email';

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
