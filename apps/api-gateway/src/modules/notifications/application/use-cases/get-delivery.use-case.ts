import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { NotificationDeliveryView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import { IGetDeliveryQuery, INotificationsGatewayPort, NOTIFICATIONS_GATEWAY_PORT } from '../ports';

// Thin gateway-side orchestrator over the `notification.delivery.get` RPC — the
// single-row drill-down by id (incl. the materialized `renderedBody`). The gateway
// threads the correlation id and maps a downstream rejection (an unknown id is a
// 404) onto the right HTTP status via `throwRpcError`.
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
