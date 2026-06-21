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

// Author Template is the registry's create-or-edit write. There is no separate
// "edit" operation: a first author for a `(eventType, channel, locale)` key writes
// `version = 1`, and every later author for the same key appends a new row at
// `(maxVersion ?? 0) + 1`, leaving the prior versions retained for audit / rollback
// (ADR-033). The live entry for a key is the highest-`version` `active` row — and
// since the new row opens `active`, the newest author becomes live without touching
// the prior rows (authoring does NOT auto-deactivate them; deactivation is the
// explicit Set-Active operation).
//
// The channel-specific subject rule (`email`/`webhook` require a subject) is enforced
// by `NotificationTemplate.create`, so an `email` author with no subject is rejected
// with `TEMPLATE_SUBJECT_REQUIRED` (→ 400) before any persist.
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

    // Derive the next business version from the registry's current high-water mark
    // across ALL rows for the key (active or not), so a rollback that deactivated the
    // newest version still advances past it rather than colliding.
    const currentMax = await this.repository.maxVersion(eventType, channel, locale);
    const nextVersion = (currentMax ?? 0) + 1;

    // Redundant safety net: the derived version should never already exist (we just
    // read the max), but a concurrent author could have raced us. The
    // `(event_type, channel, locale, version)` UNIQUE is the hard backstop; this gives
    // a typed 409 instead of a raw driver error on the common-case detection.
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

    // Build — the aggregate enforces the non-empty content + channel-specific subject
    // invariants, throwing a typed `NotificationDomainException` on a violation.
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
