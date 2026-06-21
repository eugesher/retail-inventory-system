import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import { NotificationTemplateView } from '@retail-inventory-system/contracts';

import { throwRpcError } from '../../../../common/utils';
import {
  IAuthorTemplateCommand,
  INotificationsGatewayPort,
  NOTIFICATIONS_GATEWAY_PORT,
} from '../ports';

// Thin gateway-side orchestrator over the `notification.template.author` RPC. The
// version derivation, the channel-specific subject rule, and the duplicate-version
// guard are the notification microservice's responsibility — the gateway only
// threads the correlation id and maps a downstream error onto the right HTTP status.
@Injectable()
export class AuthorTemplateUseCase {
  constructor(
    @Inject(NOTIFICATIONS_GATEWAY_PORT)
    private readonly notificationsGateway: INotificationsGatewayPort,
    @InjectPinoLogger(AuthorTemplateUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    command: IAuthorTemplateCommand,
    correlationId: string,
  ): Promise<NotificationTemplateView> {
    this.logger.assign({ correlationId });

    try {
      this.logger.info(
        { eventType: command.eventType, channel: command.channel, locale: command.locale },
        'Authoring notification template',
      );

      const template = await this.notificationsGateway.authorTemplate(command, correlationId);

      this.logger.info(
        { id: template.id, version: template.version },
        'Notification template authored',
      );

      return template;
    } catch (error) {
      this.logger.error(error, 'Error authoring notification template');

      throwRpcError(error);
    }
  }
}
