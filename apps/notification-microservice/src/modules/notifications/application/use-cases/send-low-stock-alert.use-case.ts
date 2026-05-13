import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IInventoryStockLowEvent } from '@retail-inventory-system/contracts';

import { Notification, NotificationChannelEnum } from '../../domain';
import { INotifierPort, NOTIFIER } from '../ports';

@Injectable()
export class SendLowStockAlertUseCase {
  constructor(
    @Inject(NOTIFIER)
    private readonly notifier: INotifierPort,
    @InjectPinoLogger(SendLowStockAlertUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(event: IInventoryStockLowEvent): Promise<void> {
    const notification = new Notification({
      recipient: 'ops:inventory',
      channel: NotificationChannelEnum.LOG,
      subject: `Low stock: product ${event.productId} @ ${event.storageId}`,
      body: `Product ${event.productId} in storage '${event.storageId}' has ${event.quantity} units left (threshold ${event.threshold}).`,
      metadata: {
        productId: event.productId,
        storageId: event.storageId,
        quantity: event.quantity,
        threshold: event.threshold,
        occurredAt: event.occurredAt,
      },
    });

    this.logger.info(
      {
        correlationId: event.correlationId,
        productId: event.productId,
        storageId: event.storageId,
        quantity: event.quantity,
        threshold: event.threshold,
      },
      'Dispatching low-stock notification',
    );

    await this.notifier.send(notification);
  }
}
