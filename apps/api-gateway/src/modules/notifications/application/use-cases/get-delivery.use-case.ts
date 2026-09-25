import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { NotificationDeliveryView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IGetDeliveryQuery, INotificationsGatewayPort, NOTIFICATIONS_GATEWAY_PORT } from '../ports';

@Injectable()
export class GetDeliveryUseCase {
  constructor(
    @Inject(NOTIFICATIONS_GATEWAY_PORT)
    private readonly notificationsGateway: INotificationsGatewayPort,
    @InjectPinoLogger(GetDeliveryUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    query: IGetDeliveryQuery,
    correlationId: string,
  ): Promise<NotificationDeliveryView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info({ id: query.id }, 'Fetching notification delivery');

      const delivery = await this.notificationsGateway.getDelivery(query, correlationId);

      this.logger.info(
        { id: delivery.id, status: delivery.status },
        'Notification delivery fetched',
      );

      return delivery;
    } catch (error) {
      this.logger.error(error, 'Error fetching notification delivery');

      throwRpcError(error);
    }
  }
}
