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
      subject: `Low stock: variant ${event.variantId} @ ${event.stockLocationId}`,
      body: `Variant ${event.variantId} at location '${event.stockLocationId}' has ${event.quantity} units left (threshold ${event.threshold}).`,
      metadata: {
        variantId: event.variantId,
        stockLocationId: event.stockLocationId,
        quantity: event.quantity,
        threshold: event.threshold,
        occurredAt: event.occurredAt,
      },
    });

    this.logger.info(
      {
        correlationId: event.correlationId,
        variantId: event.variantId,
        stockLocationId: event.stockLocationId,
        quantity: event.quantity,
        threshold: event.threshold,
      },
      'Dispatching low-stock notification',
    );

    await this.notifier.send(notification);
  }
}
