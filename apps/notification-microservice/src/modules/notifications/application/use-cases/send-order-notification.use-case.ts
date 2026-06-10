import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailOrderPlacedEvent } from '@retail-inventory-system/contracts';

import { Notification, NotificationChannelEnum } from '../../domain';
import { INotifierPort, NOTIFIER } from '../ports';

@Injectable()
export class SendOrderNotificationUseCase {
  constructor(
    @Inject(NOTIFIER)
    private readonly notifier: INotifierPort,
    @InjectPinoLogger(SendOrderNotificationUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(event: IRetailOrderPlacedEvent): Promise<void> {
    const lineWord = event.lineCount === 1 ? 'line' : 'lines';

    const notification = new Notification({
      recipient: `order:${event.orderId}`,
      channel: NotificationChannelEnum.LOG,
      subject: `Order ${event.orderNumber} placed`,
      body:
        `Order ${event.orderNumber} (${event.lineCount} ${lineWord}) was placed ` +
        `for ${event.grandTotalMinor} ${event.currency} minor units.`,
      metadata: {
        orderId: event.orderId,
        orderNumber: event.orderNumber,
        customerId: event.customerId,
        grandTotalMinor: event.grandTotalMinor,
        currency: event.currency,
        lineCount: event.lineCount,
        occurredAt: event.occurredAt,
      },
    });

    this.logger.info(
      {
        correlationId: event.correlationId,
        orderId: event.orderId,
        orderNumber: event.orderNumber,
        grandTotalMinor: event.grandTotalMinor,
        currency: event.currency,
        lineCount: event.lineCount,
      },
      'Dispatching order-placed notification',
    );

    await this.notifier.send(notification);
  }
}
