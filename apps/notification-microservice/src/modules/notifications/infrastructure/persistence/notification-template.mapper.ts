import { DeepPartial } from 'typeorm';

import { NotificationTemplate } from '../../domain';
import { NotificationTemplateEntity } from './notification-template.entity';

export class NotificationTemplateMapper {
  public static toEntity(domain: NotificationTemplate): DeepPartial<NotificationTemplateEntity> {
    const entity: DeepPartial<NotificationTemplateEntity> = {
      eventType: domain.eventType,
      channel: domain.channel,
      locale: domain.locale,
      subject: domain.subject,
      body: domain.body,
      version: domain.version,
      active: domain.active,
    };

    if (domain.id !== null) {
      entity.id = domain.id;
    }

    return entity;
  }

  public static toDomain(entity: NotificationTemplateEntity): NotificationTemplate {
    return NotificationTemplate.reconstitute({
      id: Number(entity.id),
      eventType: entity.eventType,
      channel: entity.channel,
      locale: entity.locale,
      subject: entity.subject ?? null,
      body: entity.body,
      version: Number(entity.version),
      active: Boolean(entity.active),
      createdAt: entity.createdAt ?? null,
      updatedAt: entity.updatedAt ?? null,
    });
  }
}
