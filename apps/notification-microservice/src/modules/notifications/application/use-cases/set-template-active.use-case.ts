import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INotificationTemplateSetActivePayload,
  NotificationTemplateView,
} from '@retail-inventory-system/contracts';

import { NotificationDomainException, NotificationErrorCodeEnum } from '../../domain';
import { INotificationTemplateRepositoryPort, NOTIFICATION_TEMPLATE_REPOSITORY } from '../ports';
import { toNotificationTemplateView } from './notification-template-view.factory';

@Injectable()
export class SetTemplateActiveUseCase {
  constructor(
    @Inject(NOTIFICATION_TEMPLATE_REPOSITORY)
    private readonly repository: INotificationTemplateRepositoryPort,
    @InjectPinoLogger(SetTemplateActiveUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(
    payload: INotificationTemplateSetActivePayload,
  ): Promise<NotificationTemplateView> {
    const { id, active, correlationId } = payload;

    this.logger.info(
      { correlationId, templateId: id, active },
      'Received RPC: set notification template active',
    );

    const template = await this.repository.findById(id);
    if (template === null) {
      throw new NotificationDomainException(
        NotificationErrorCodeEnum.TEMPLATE_NOT_FOUND,
        `Notification template ${id} not found`,
      );
    }

    if (active) {
      template.activate();
    } else {
      template.deactivate();
    }

    const saved = await this.repository.save(template);

    this.logger.info(
      { correlationId, templateId: saved.id, active: saved.active },
      'Notification template active flag updated',
    );

    return toNotificationTemplateView(saved);
  }
}
