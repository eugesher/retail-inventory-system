import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INotificationTemplateListPayload,
  NotificationTemplateView,
} from '@retail-inventory-system/contracts';

import { INotificationTemplateRepositoryPort, NOTIFICATION_TEMPLATE_REPOSITORY } from '../ports';
import { toNotificationTemplateView } from './notification-template-view.factory';

// List is the staff-facing registry browse: a filtered, unpaginated read of the
// template registry (the registry is small). Every filter field is optional and
// narrows the scan — an absent field widens it, so an empty filter lists every
// template, every version (active or not). The list spans all versions so staff can
// see (and roll back to) the full edit history (ADR-033).
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
