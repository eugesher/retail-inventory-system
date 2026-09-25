import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { NotificationTemplateView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import {
  INotificationsGatewayPort,
  ISetTemplateActiveCommand,
  NOTIFICATIONS_GATEWAY_PORT,
} from '../ports';

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
