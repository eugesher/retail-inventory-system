import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { NotificationTemplateView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import {
  IListTemplatesQuery,
  INotificationsGatewayPort,
  NOTIFICATIONS_GATEWAY_PORT,
} from '../ports';

// Thin gateway-side orchestrator over the `notification.template.list` RPC — the
// filtered registry browse (every version, active or not). The filtering + ordering
// are the notification microservice's responsibility; the gateway threads the
// correlation id and maps any downstream rejection onto the right HTTP status.
@Injectable()
export class ListTemplatesUseCase {
  constructor(
    @Inject(NOTIFICATIONS_GATEWAY_PORT)
    private readonly notificationsGateway: INotificationsGatewayPort,
    @InjectPinoLogger(ListTemplatesUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    query: IListTemplatesQuery,
    correlationId: string,
  ): Promise<NotificationTemplateView[]> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(query, 'Listing notification templates');

      const templates = await this.notificationsGateway.listTemplates(query, correlationId);

      this.logger.info({ returned: templates.length }, 'Notification templates listed');

      return templates;
    } catch (error) {
      this.logger.error(error, 'Error listing notification templates');

      throwRpcError(error);
    }
  }
}
