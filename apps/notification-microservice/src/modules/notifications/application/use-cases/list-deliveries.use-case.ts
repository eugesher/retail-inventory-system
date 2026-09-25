import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { clampPageWindow } from '@retail-inventory-system/common';
import {
  INotificationDeliveryListPayload,
  IPage,
  NotificationDeliveryView,
} from '@retail-inventory-system/contracts';

import { INotificationDeliveryRepositoryPort, NOTIFICATION_DELIVERY_REPOSITORY } from '../ports';
import { toNotificationDeliveryView } from './notification-delivery-view.factory';

@Injectable()
export class ListDeliveriesUseCase {
  constructor(
    @Inject(NOTIFICATION_DELIVERY_REPOSITORY)
    private readonly repository: INotificationDeliveryRepositoryPort,
    @InjectPinoLogger(ListDeliveriesUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    payload: INotificationDeliveryListPayload,
  ): Promise<IPage<NotificationDeliveryView>> {
    const { customerId, eventReferenceType, eventReferenceId, status, correlationId } = payload;
    const { page, size } = clampPageWindow(payload.page, payload.pageSize);

    this.logger.info(
      { correlationId, customerId, eventReferenceType, eventReferenceId, status, page, size },
      'Received RPC: list notification deliveries (audit read)',
    );

    const deliveriesPage = await this.repository.list(
      { recipientCustomerId: customerId, eventReferenceType, eventReferenceId, status },
      { page, size },
    );

    return {
      items: deliveriesPage.items.map(toNotificationDeliveryView),
      total: deliveriesPage.total,
      page: deliveriesPage.page,
      size: deliveriesPage.size,
    };
  }
}
