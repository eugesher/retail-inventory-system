import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  IRetailRefundIssuedEvent,
  NotificationChannelEnum,
} from '@retail-inventory-system/contracts';

import { Notification } from '../../domain';
import { INotifierPort, NOTIFIER } from '../ports';

// Fans the `retail.refund.issued` event out through the notifier — the buyer-facing
// confirmation that money went back. A single typed entry method (`issued`) following the
// one-use-case-per-concern style of its siblings; should a `retail.refund.failed`
// confirmation ever be surfaced, it would join here as a second method. (Today
// `retail.refund.failed` stays a reserved surface on `retail_queue` with no consumer — a
// decline is an internal/operational concern, not a buyer notification.)
//
// The refund event carries no `customerId`, so the recipient is derived from `orderId`
// (`order:<id>`) — the shipment-notification precedent. Delivery is the
// `LogNotifierAdapter` this capability; templated email/SMS is deferred. The
// `correlationId` is logged inline (never via `PinoLogger.assign`, which throws outside
// request scope, ADR-011 §7).
@Injectable()
export class SendRefundNotificationUseCase {
  constructor(
    @Inject(NOTIFIER)
    private readonly notifier: INotifierPort,
    @InjectPinoLogger(SendRefundNotificationUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async issued(event: IRetailRefundIssuedEvent): Promise<void> {
    const notification = new Notification({
      recipient: `order:${event.orderId}`,
      channel: NotificationChannelEnum.EMAIL,
      subject: `Refund issued for order ${event.orderId}`,
      body:
        `Refund ${event.refundId} of ${event.amountMinor} ${event.currency} (minor units) was ` +
        `issued for order ${event.orderId} against payment ${event.paymentId} at ${event.issuedAt}.`,
      metadata: {
        refundId: event.refundId,
        orderId: event.orderId,
        paymentId: event.paymentId,
        amountMinor: event.amountMinor,
        currency: event.currency,
        issuedAt: event.issuedAt,
        occurredAt: event.occurredAt,
      },
    });

    this.logger.info(
      {
        correlationId: event.correlationId,
        refundId: event.refundId,
        orderId: event.orderId,
        paymentId: event.paymentId,
        amountMinor: event.amountMinor,
        currency: event.currency,
      },
      'Dispatching refund-issued notification',
    );

    await this.notifier.send(notification);
  }
}
