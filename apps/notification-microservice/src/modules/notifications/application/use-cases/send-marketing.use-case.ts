import { Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INotificationMarketingSendPayload,
  NotificationChannelEnum,
  NotificationDeliveryView,
} from '@retail-inventory-system/contracts';

import { RenderAndDispatchUseCase } from './render-and-dispatch.use-case';
import { toNotificationDeliveryView } from './notification-delivery-view.factory';

@Injectable()
export class SendMarketingUseCase {
  constructor(
    private readonly renderAndDispatch: RenderAndDispatchUseCase,
    @InjectPinoLogger(SendMarketingUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    payload: INotificationMarketingSendPayload,
  ): Promise<NotificationDeliveryView | null> {
    this.logger.info(
      {
        correlationId: payload.correlationId,
        customerId: payload.customerId,
        eventType: payload.eventType,
        campaignId: payload.campaignId,
      },
      'Received RPC: send marketing notification',
    );

    const delivery = await this.renderAndDispatch.execute({
      eventType: payload.eventType,
      channel: NotificationChannelEnum.EMAIL,
      recipientCustomerId: payload.customerId,
      recipientAddress: payload.customerEmail,
      eventReferenceType: 'marketing',
      eventReferenceId: payload.campaignId,
      context: payload.context,
      correlationId: payload.correlationId,
    });

    return delivery === null ? null : toNotificationDeliveryView(delivery);
  }
}
