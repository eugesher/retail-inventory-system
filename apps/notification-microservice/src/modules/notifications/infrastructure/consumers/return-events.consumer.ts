import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IRetailReturnAuthorizedEvent,
  IRetailReturnInspectedEvent,
  IRetailReturnReceivedEvent,
  IRetailReturnRequestedEvent,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { RenderAndDispatchUseCase } from '../../application/use-cases';
import { dispatchCustomerEmailNotification } from './dispatch-customer-email';

@Controller()
export class ReturnEventsConsumer {
  constructor(
    private readonly renderAndDispatch: RenderAndDispatchUseCase,
    @InjectPinoLogger(ReturnEventsConsumer.name)
    private readonly logger: PinoLogger,
  ) {}

  @EventPattern(ROUTING_KEYS.RETAIL_RETURN_REQUESTED)
  public async onRequested(@Payload() event: IRetailReturnRequestedEvent): Promise<void> {
    await dispatchCustomerEmailNotification(this.renderAndDispatch, this.logger, {
      eventType: ROUTING_KEYS.RETAIL_RETURN_REQUESTED,
      eventReferenceType: 'return-request',
      eventReferenceId: String(event.rmaId),
      recipientCustomerId: event.customerId,
      customerEmail: event.customerEmail,
      context: { ...event },
      correlationId: event.correlationId,
    });
  }

  @EventPattern(ROUTING_KEYS.RETAIL_RETURN_AUTHORIZED)
  public async onAuthorized(@Payload() event: IRetailReturnAuthorizedEvent): Promise<void> {
    await dispatchCustomerEmailNotification(this.renderAndDispatch, this.logger, {
      eventType: ROUTING_KEYS.RETAIL_RETURN_AUTHORIZED,
      eventReferenceType: 'return-request',
      eventReferenceId: String(event.rmaId),
      recipientCustomerId: event.customerId,
      customerEmail: event.customerEmail,
      context: { ...event },
      correlationId: event.correlationId,
    });
  }

  @EventPattern(ROUTING_KEYS.RETAIL_RETURN_RECEIVED)
  public async onReceived(@Payload() event: IRetailReturnReceivedEvent): Promise<void> {
    await dispatchCustomerEmailNotification(this.renderAndDispatch, this.logger, {
      eventType: ROUTING_KEYS.RETAIL_RETURN_RECEIVED,
      eventReferenceType: 'return-request',
      eventReferenceId: String(event.rmaId),
      recipientCustomerId: event.customerId,
      customerEmail: event.customerEmail,
      context: { ...event },
      correlationId: event.correlationId,
    });
  }

  @EventPattern(ROUTING_KEYS.RETAIL_RETURN_INSPECTED)
  public async onInspected(@Payload() event: IRetailReturnInspectedEvent): Promise<void> {
    await dispatchCustomerEmailNotification(this.renderAndDispatch, this.logger, {
      eventType: ROUTING_KEYS.RETAIL_RETURN_INSPECTED,
      eventReferenceType: 'return-request',
      eventReferenceId: String(event.rmaId),
      recipientCustomerId: event.customerId,
      customerEmail: event.customerEmail,
      context: { ...event },
      correlationId: event.correlationId,
    });
  }
}
