import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INotificationTemplateAuthorPayload,
  NotificationTemplateView,
} from '@retail-inventory-system/contracts';

import {
  NotificationDomainException,
  NotificationErrorCodeEnum,
  NotificationTemplate,
} from '../../domain';
import { INotificationTemplateRepositoryPort, NOTIFICATION_TEMPLATE_REPOSITORY } from '../ports';
import { toNotificationTemplateView } from './notification-template-view.factory';

@Injectable()
export class AuthorTemplateUseCase {
  constructor(
    @Inject(NOTIFICATION_TEMPLATE_REPOSITORY)
    private readonly repository: INotificationTemplateRepositoryPort,
    @InjectPinoLogger(AuthorTemplateUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    payload: INotificationTemplateAuthorPayload,
  ): Promise<NotificationTemplateView> {
    const { eventType, channel, locale, subject, body, correlationId } = payload;

    this.logger.info(
      { correlationId, eventType, channel, locale },
      'Received RPC: author notification template',
    );

    const currentMax = await this.repository.maxVersion(eventType, channel, locale);
    const nextVersion = (currentMax ?? 0) + 1;

    const collision = await this.repository.findByNaturalKey(
      eventType,
      channel,
      locale,
      nextVersion,
    );
    if (collision !== null) {
      throw new NotificationDomainException(
        NotificationErrorCodeEnum.TEMPLATE_DUPLICATE_VERSION,
        `A notification template for (${eventType}, ${channel}, ${locale}) at version ${nextVersion} already exists`,
      );
    }

    const template = NotificationTemplate.create({
      eventType,
      channel,
      locale,
      subject: subject ?? null,
      body,
      version: nextVersion,
    });

    const saved = await this.repository.save(template);
    if (saved.id === null) {
      throw new Error('AuthorTemplateUseCase: repository returned an unsaved aggregate');
    }

    this.logger.info(
      { correlationId, templateId: saved.id, version: saved.version },
      'Notification template authored',
    );

    return toNotificationTemplateView(saved);
  }
}
