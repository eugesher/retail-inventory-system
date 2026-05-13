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
      recipient: `customer:${event.customerId}`,
      channel: NotificationChannelEnum.LOG,
      subject: `Order ${event.orderId} received`,
      body: `Order ${event.orderId} for customer ${event.customerId} is now ${event.status}. Items: ${event.products.length}.`,
      metadata: {
        orderId: event.orderId,
        customerId: event.customerId,
        status: event.status,
        productCount: event.products.length,
        occurredAt: event.occurredAt,
      },
    });

    this.logger.info(
      {
        correlationId: event.correlationId,
        orderId: event.orderId,
        customerId: event.customerId,
      },
      'Dispatching order-created notification',
    );

    await this.notifier.send(notification);
  }
}
