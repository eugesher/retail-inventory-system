import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INotificationDeliveryRecordOutcomePayload,
  NotificationDeliveryView,
} from '@retail-inventory-system/contracts';

import { NotificationDomainException, NotificationErrorCodeEnum } from '../../domain';
import { INotificationDeliveryRepositoryPort, NOTIFICATION_DELIVERY_REPOSITORY } from '../ports';
import { toNotificationDeliveryView } from './notification-delivery-view.factory';

const DEFAULT_BOUNCE_REASON = 'Delivery bounced';

@Injectable()
export class RecordDeliveryOutcomeUseCase {
  constructor(
    @Inject(NOTIFICATION_DELIVERY_REPOSITORY)
    private readonly repository: INotificationDeliveryRepositoryPort,
    @InjectPinoLogger(RecordDeliveryOutcomeUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    payload: INotificationDeliveryRecordOutcomePayload,
  ): Promise<NotificationDeliveryView> {
    const { deliveryId, outcome, failureReason, correlationId } = payload;

    this.logger.info(
      { correlationId, deliveryId, outcome },
      'Received RPC: record notification delivery outcome',
    );

    const delivery = await this.repository.findById(deliveryId);
    if (delivery === null) {
      throw new NotificationDomainException(
        NotificationErrorCodeEnum.DELIVERY_NOT_FOUND,
        `Notification delivery ${deliveryId} not found`,
      );
    }

    if (outcome === 'delivered') {
      delivery.markDelivered();
    } else {
      delivery.markBounced(failureReason ?? DEFAULT_BOUNCE_REASON);
    }

    const saved = await this.repository.save(delivery);

    this.logger.info(
      { correlationId, deliveryId: saved.id, status: saved.status },
      'Notification delivery outcome recorded',
    );

    return toNotificationDeliveryView(saved);
  }
}
