import { DeepPartial } from 'typeorm';

import { NotificationTemplate } from '../../domain';
import { NotificationTemplateEntity } from './notification-template.entity';

export class NotificationTemplateMapper {
  // `id` is omitted when null so TypeORM inserts; present so it updates. `version` IS
  // written here — unlike an OCC `@VersionColumn`, this is a plain business-version
  // column the registry owns (the value is part of the natural key, so the mapper must
  // persist exactly what the domain carries). `active` is a plain boolean (mysql2 maps
  // TINYINT(1) ↔ boolean via the entity's `type: 'boolean'`).
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
      // The BIGINT PK comes back as a number via `@PrimaryGeneratedColumn()`.
      id: Number(entity.id),
      eventType: entity.eventType,
      channel: entity.channel,
      locale: entity.locale,
      subject: entity.subject ?? null,
      body: entity.body,
      // `version` is INT, returned as a number; coerce defensively for parity.
      version: Number(entity.version),
      // mysql2 surfaces TINYINT(1) as a number under some drivers; coerce to a real
      // boolean so the domain's `active` getter is honest.
      active: Boolean(entity.active),
      createdAt: entity.createdAt ?? null,
      updatedAt: entity.updatedAt ?? null,
    });
  }
}
