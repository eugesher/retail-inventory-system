import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';

import { IRetailRefundIssuedEvent } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { SendRefundNotificationUseCase } from '../../application/use-cases';

// Subscribes to `retail.refund.issued`, which the retail orders module emits onto
// `notification_events` (the producer-targets-consumer-queue routing, ADR-008/020) for
// both an explicit Issue Refund and the auto-refund-from-cancel path. Like the sibling
// consumers it is a thin adapter: it translates the wire payload into a use-case call and
// lets the use case build + dispatch the `Notification`. The `correlationId` is logged
// inline by the use case (ADR-011 §7).
//
// `retail.refund.failed` is NOT consumed here — it stays a reserved surface on
// `retail_queue` (a gateway decline is an operational outcome, not a buyer notification).
@Controller()
export class RefundEventsConsumer {
  constructor(private readonly useCase: SendRefundNotificationUseCase) {}

  @EventPattern(ROUTING_KEYS.RETAIL_REFUND_ISSUED)
  public async onIssued(@Payload() event: IRetailRefundIssuedEvent): Promise<void> {
    await this.useCase.issued(event);
  }
}
