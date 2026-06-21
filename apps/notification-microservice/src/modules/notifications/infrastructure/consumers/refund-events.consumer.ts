import { Controller } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailRefundIssuedEvent } from '@retail-inventory-system/contracts';
import { ROUTING_KEYS } from '@retail-inventory-system/messaging';

import { RenderAndDispatchUseCase } from '../../application/use-cases';
import { dispatchCustomerEmailNotification } from './dispatch-customer-email';

// Consumes `retail.refund.issued` off `notification_events` (emitted by both the explicit
// Issue Refund and the auto-refund-from-cancel path, ADR-008/020) and routes it through the
// template-driven `RenderAndDispatchUseCase` (ADR-033) — the buyer-facing confirmation that
// money went back. The reference is the `refundId` (the `refund` reference type).
//
// The refund event carries the buyer's resolved `customerEmail` (producer-side, from the
// refund's order, ADR-033) but NOT a `customerId`, so `recipientCustomerId` is `null` — this
// row is not deduped (ADR-033's null-recipient rule). A `null` email warn-logs and skips in
// the shared helper. `correlationId` is logged inline (ADR-011 §7).
//
// `retail.refund.failed` is NOT consumed here — it stays a reserved surface on `retail_queue`
// (a gateway decline is an operational outcome, not a buyer notification).
@Controller()
export class RefundEventsConsumer {
  constructor(
    private readonly renderAndDispatch: RenderAndDispatchUseCase,
    @InjectPinoLogger(RefundEventsConsumer.name)
    private readonly logger: PinoLogger,
  ) {}

  @EventPattern(ROUTING_KEYS.RETAIL_REFUND_ISSUED)
  public async onIssued(@Payload() event: IRetailRefundIssuedEvent): Promise<void> {
    await dispatchCustomerEmailNotification(this.renderAndDispatch, this.logger, {
      eventType: ROUTING_KEYS.RETAIL_REFUND_ISSUED,
      eventReferenceType: 'refund',
      eventReferenceId: String(event.refundId),
      recipientCustomerId: null,
      customerEmail: event.customerEmail,
      context: { ...event },
      correlationId: event.correlationId,
    });
  }
}
