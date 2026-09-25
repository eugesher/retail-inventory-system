import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INotificationTemplateListPayload,
  NotificationTemplateView,
} from '@retail-inventory-system/contracts';

import { INotificationTemplateRepositoryPort, NOTIFICATION_TEMPLATE_REPOSITORY } from '../ports';
import { toNotificationTemplateView } from './notification-template-view.factory';

@Injectable()
export class ListTemplatesUseCase {
  constructor(
    @Inject(NOTIFICATION_TEMPLATE_REPOSITORY)
    private readonly repository: INotificationTemplateRepositoryPort,
    @InjectPinoLogger(ListTemplatesUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    payload: INotificationTemplateListPayload,
  ): Promise<NotificationTemplateView[]> {
    const { eventType, channel, locale, correlationId } = payload;

    this.logger.info(
      { correlationId, eventType, channel, locale },
      'Received RPC: list notification templates',
    );

    const templates = await this.repository.list({ eventType, channel, locale });

    return templates.map(toNotificationTemplateView);
  }
}
