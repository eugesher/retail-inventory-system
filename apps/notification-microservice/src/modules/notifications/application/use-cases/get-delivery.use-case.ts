import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INotificationDeliveryGetPayload,
  NotificationDeliveryView,
} from '@retail-inventory-system/contracts';

import { NotificationDomainException, NotificationErrorCodeEnum } from '../../domain';
import { INotificationDeliveryRepositoryPort, NOTIFICATION_DELIVERY_REPOSITORY } from '../ports';
import { toNotificationDeliveryView } from './notification-delivery-view.factory';

// Get Delivery: the single-row drill-down of one `notification_delivery` audit row by id
// — including the full materialized `renderedBody`/`renderedSubject` (ADR-033). An unknown
// id is a typed `DELIVERY_NOT_FOUND` (404), mapped to HTTP by the
// `NotificationRpcExceptionFilter`.
@Injectable()
export class GetDeliveryUseCase {
  constructor(
    @Inject(NOTIFICATION_DELIVERY_REPOSITORY)
    private readonly repository: INotificationDeliveryRepositoryPort,
    @InjectPinoLogger(GetDeliveryUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    payload: INotificationDeliveryGetPayload,
  ): Promise<NotificationDeliveryView> {
    const { id, correlationId } = payload;

    this.logger.info({ correlationId, deliveryId: id }, 'Received RPC: get notification delivery');

    const delivery = await this.repository.findById(id);
    if (delivery === null) {
      throw new NotificationDomainException(
        NotificationErrorCodeEnum.DELIVERY_NOT_FOUND,
        `Notification delivery ${id} not found`,
      );
    }

    return toNotificationDeliveryView(delivery);
  }
}
