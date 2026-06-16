import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

import {
  IRetailFulfillmentDeliveredEvent,
  IRetailFulfillmentShippedEvent,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { SendShipmentNotificationUseCase } from '../../application/use-cases';

// Subscribes to the two fulfillment lifecycle events the retail orders module emits onto
// `notification_events` (the producer-targets-consumer-queue routing, ADR-008/020). Like
// the sibling consumers it is a thin adapter: it translates the wire payload into a
// use-case call and lets the use case build + dispatch the `Notification`. The
// `correlationId` is logged inline by the use case (ADR-011 §7 — `PinoLogger.assign`
// throws outside request scope, so it never runs in an `@EventPattern` handler).
@Controller()
export class FulfillmentEventsConsumer {
  constructor(private readonly useCase: SendShipmentNotificationUseCase) {}

  @EventPattern(ROUTING_KEYS.RETAIL_FULFILLMENT_SHIPPED)
  public async onShipped(@Payload() event: IRetailFulfillmentShippedEvent): Promise<void> {
    await this.useCase.shipped(event);
  }

  @EventPattern(ROUTING_KEYS.RETAIL_FULFILLMENT_DELIVERED)
  public async onDelivered(@Payload() event: IRetailFulfillmentDeliveredEvent): Promise<void> {
    await this.useCase.delivered(event);
  }
}
