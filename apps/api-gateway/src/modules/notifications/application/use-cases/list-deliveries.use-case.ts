import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { IPage, NotificationDeliveryView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import {
  IListDeliveriesQuery,
  INotificationsGatewayPort,
  NOTIFICATIONS_GATEWAY_PORT,
} from '../ports';

// Thin gateway-side orchestrator over the `notification.delivery.list` RPC — the
// paginated, filterable, newest-first audit read of the delivery trail. The paging,
// filtering, and ordering are the notification microservice's responsibility; the
// gateway forwards the query (with the correlation id stitched in the adapter) and
// maps any downstream rejection onto the right HTTP status via `throwRpcError`.
@Injectable()
export class ListDeliveriesUseCase {
  constructor(
    @Inject(NOTIFICATIONS_GATEWAY_PORT)
    private readonly notificationsGateway: INotificationsGatewayPort,
    @InjectPinoLogger(ListDeliveriesUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    query: IListDeliveriesQuery,
    correlationId: string,
  ): Promise<IPage<NotificationDeliveryView>> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { page: query.page, pageSize: query.pageSize, status: query.status },
        'Listing notification deliveries',
      );

      const result = await this.notificationsGateway.listDeliveries(query, correlationId);

      this.logger.info(
        { total: result.total, returned: result.items.length },
        'Notification deliveries listed',
      );

      return result;
    } catch (error) {
      this.logger.error(error, 'Error listing notification deliveries');

      throwRpcError(error);
    }
  }
}
