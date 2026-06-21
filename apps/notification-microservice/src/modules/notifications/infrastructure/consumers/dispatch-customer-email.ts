import { PinoLogger } from 'nestjs-pino';

import { NotificationChannelEnum } from '@retail-inventory-system/contracts';

import { RenderAndDispatchUseCase } from '../../application/use-cases';

// The shared customer-facing leg every buyer-notification consumer runs. The per-consumer
// mapping (which routing key is the `eventType`, which event field is the reference id,
// whether the event carries a `customerId`) stays visible in each consumer; this helper
// owns only the two things they all share:
//
//  1. **The missing-recipient skip.** A customer-facing event may carry no email — a
//     tombstoned or guest customer with no contact on file (`customerEmail` resolved to
//     `null` producer-side, ADR-033). The `Notification` value object requires a non-empty
//     recipient, so dispatching to an empty address would throw. Instead we `warn`-log
//     (with `correlationId`, ADR-011 §7) and skip — there is simply no one to notify.
//  2. **The render-and-dispatch call** with `channel = EMAIL` (the only business channel
//     this capability) and the resolved address.
//
// `recipientCustomerId` is the dedupe anchor: when the event carries the buyer's id
// (`retail.order.placed`, the `retail.return.*` family) it is passed through so a
// redelivery is collapsed to a no-op; events that carry only the email (`order.cancelled`,
// `fulfillment.*`, `refund.issued`) pass `null` and are not deduped (the ADR-033
// null-recipient rule — at-least-once redelivery may re-send those, a known limitation
// until those wire contracts also carry `customerId`).
export interface ICustomerEmailDispatch {
  eventType: string;
  eventReferenceType: string;
  eventReferenceId: string;
  recipientCustomerId: string | null;
  customerEmail: string | null | undefined;
  context: Record<string, unknown>;
  correlationId: string;
}

export async function dispatchCustomerEmailNotification(
  renderAndDispatch: RenderAndDispatchUseCase,
  logger: PinoLogger,
  params: ICustomerEmailDispatch,
): Promise<void> {
  if (params.customerEmail == null || params.customerEmail.trim().length === 0) {
    logger.warn(
      {
        correlationId: params.correlationId,
        eventType: params.eventType,
        eventReferenceType: params.eventReferenceType,
        eventReferenceId: params.eventReferenceId,
      },
      'Customer-facing event has no recipient email; skipping notification',
    );
    return;
  }

  await renderAndDispatch.execute({
    eventType: params.eventType,
    channel: NotificationChannelEnum.EMAIL,
    recipientCustomerId: params.recipientCustomerId,
    recipientAddress: params.customerEmail,
    eventReferenceType: params.eventReferenceType,
    eventReferenceId: params.eventReferenceId,
    context: params.context,
    correlationId: params.correlationId,
  });
}
