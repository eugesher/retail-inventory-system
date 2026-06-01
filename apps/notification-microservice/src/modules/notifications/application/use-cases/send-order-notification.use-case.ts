import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IRetailOrderCreatedEvent } from '@retail-inventory-system/contracts';

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

  public async execute(event: IRetailOrderCreatedEvent): Promise<void> {
    const notification = new Notification({
      recipient: `order:${event.orderId}`,
      channel: NotificationChannelEnum.LOG,
      subject: `Order ${event.orderId} received`,
      body: `Order ${event.orderId} is now ${event.status}. Items: ${event.products.length}.`,
      metadata: {
        orderId: event.orderId,
        status: event.status,
        productCount: event.products.length,
        occurredAt: event.occurredAt,
      },
    });

    this.logger.info(
      {
        correlationId: event.correlationId,
        orderId: event.orderId,
      },
      'Dispatching order-created notification',
    );

    await this.notifier.send(notification);
  }
}
