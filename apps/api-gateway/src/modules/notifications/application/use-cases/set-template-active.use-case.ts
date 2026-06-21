import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { NotificationTemplateView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import {
  INotificationsGatewayPort,
  ISetTemplateActiveCommand,
  NOTIFICATIONS_GATEWAY_PORT,
} from '../ports';

// Thin gateway-side orchestrator over the `notification.template.set-active` RPC —
// the rollback lever (deactivate the newest version so resolution falls through to
// the prior active one, or re-activate an earlier version). The find-by-id +
// activate/deactivate are the notification microservice's responsibility; the
// gateway threads the correlation id and maps a downstream rejection (an unknown id
// is a 404) onto the right HTTP status via `throwRpcError`.
@Injectable()
export class SetTemplateActiveUseCase {
  constructor(
    @Inject(NOTIFICATIONS_GATEWAY_PORT)
    private readonly notificationsGateway: INotificationsGatewayPort,
    @InjectPinoLogger(SetTemplateActiveUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    command: ISetTemplateActiveCommand,
    correlationId: string,
  ): Promise<NotificationTemplateView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { id: command.id, active: command.active },
        'Setting notification template active flag',
      );

      const template = await this.notificationsGateway.setTemplateActive(command, correlationId);

      this.logger.info(
        { id: template.id, active: template.active },
        'Notification template active flag set',
      );

      return template;
    } catch (error) {
      this.logger.error(error, 'Error setting notification template active flag');

      throwRpcError(error);
    }
  }
}
