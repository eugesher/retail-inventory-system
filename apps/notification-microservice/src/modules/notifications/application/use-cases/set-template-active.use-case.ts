import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  INotificationTemplateSetActivePayload,
  NotificationTemplateView,
} from '@retail-inventory-system/contracts';

import { NotificationDomainException, NotificationErrorCodeEnum } from '../../domain';
import { INotificationTemplateRepositoryPort, NOTIFICATION_TEMPLATE_REPOSITORY } from '../ports';
import { toNotificationTemplateView } from './notification-template-view.factory';

// Set-Active activates or deactivates one template **version** by id. Deactivating
// flips the row out of the "find latest active" resolution while keeping it on disk
// (soft-delete via the `active` flag, never `deletedAt`), and activating is the
// inverse — both are idempotent on the aggregate. This is the rollback lever: to
// revert to an earlier wording, deactivate the live version and activate the desired
// earlier one (or author a fresh version matching the old body). An unknown id is a
// 404 (`TEMPLATE_NOT_FOUND`).
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
