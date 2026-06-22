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

// Consumes the four buyer-facing return lifecycle events the retail returns module emits
// onto `notification_events` (the producer-targets-consumer-queue routing, ADR-008/020) and
// routes each through the template-driven `RenderAndDispatchUseCase` (ADR-033). Each handler
// keys its own template (`retail.return.requested` / `.authorized` / `.received` /
// `.inspected`); they all reference the RMA by `rmaId` (the `return-request` reference type).
//
// Every return event carries the buyer's `customerId`, so it is passed through as the dedupe
// anchor (a redelivery is collapsed to a no-op) alongside the resolved `customerEmail` — a
// `null` email warn-logs and skips in the shared helper. `correlationId` is logged inline
// (ADR-011 §7).
//
// `retail.return.rejected` / `.closed` are NOT consumed here — they stay reserved surfaces on
// `retail_queue` (a rejection/closure is an operational outcome, not yet a buyer notification).
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
