import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

import {
  IRetailReturnAuthorizedEvent,
  IRetailReturnInspectedEvent,
  IRetailReturnReceivedEvent,
  IRetailReturnRequestedEvent,
} from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { SendReturnNotificationUseCase } from '../../application/use-cases';

// Subscribes to the four buyer-facing return lifecycle events the retail returns module
// emits onto `notification_events` (the producer-targets-consumer-queue routing,
// ADR-008/020). Like the sibling consumers it is a thin adapter: it translates the wire
// payload into a use-case call and lets the use case build + dispatch the `Notification`.
// The `correlationId` is logged inline by the use case (ADR-011 §7 — `PinoLogger.assign`
// throws outside request scope, so it never runs in an `@EventPattern` handler).
//
// `retail.return.rejected` and `.closed` are NOT consumed here — they stay reserved
// surfaces on `retail_queue` (a rejection/closure is an operational outcome, not yet a
// buyer notification).
@Controller()
export class ReturnEventsConsumer {
  constructor(private readonly useCase: SendReturnNotificationUseCase) {}

  @EventPattern(ROUTING_KEYS.RETAIL_RETURN_REQUESTED)
  public async onRequested(@Payload() event: IRetailReturnRequestedEvent): Promise<void> {
    await this.useCase.requested(event);
  }

  @EventPattern(ROUTING_KEYS.RETAIL_RETURN_AUTHORIZED)
  public async onAuthorized(@Payload() event: IRetailReturnAuthorizedEvent): Promise<void> {
    await this.useCase.authorized(event);
  }

  @EventPattern(ROUTING_KEYS.RETAIL_RETURN_RECEIVED)
  public async onReceived(@Payload() event: IRetailReturnReceivedEvent): Promise<void> {
    await this.useCase.received(event);
  }

  @EventPattern(ROUTING_KEYS.RETAIL_RETURN_INSPECTED)
  public async onInspected(@Payload() event: IRetailReturnInspectedEvent): Promise<void> {
    await this.useCase.inspected(event);
  }
}
