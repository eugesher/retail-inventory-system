import { DeepPartial } from 'typeorm';

import { AuditLogEntry } from '../../domain';
import { AuditLogEntryEntity } from './audit-log-entry.entity';

export class AuditLogEntryMapper {
  public static toDomain(entity: AuditLogEntryEntity): AuditLogEntry {
    return AuditLogEntry.reconstitute({
      id: Number(entity.id),
      actorId: entity.actorId ?? null,
      actorType: entity.actorType,
      action: entity.action,
      entityType: entity.entityType ?? null,
      entityId: entity.entityId ?? null,
      before: entity.before ?? null,
      after: entity.after ?? null,
      occurredAt: entity.occurredAt,
      ipAddress: entity.ipAddress ?? null,
      correlationId: entity.correlationId ?? null,
    });
  }

  public static toEntity(domain: AuditLogEntry): DeepPartial<AuditLogEntryEntity> {
    return {
      actorId: domain.actorId,
      actorType: domain.actorType,
      action: domain.action,
      entityType: domain.entityType,
      entityId: domain.entityId,
      before: domain.before,
      after: domain.after,
      occurredAt: domain.occurredAt,
      ipAddress: domain.ipAddress,
      correlationId: domain.correlationId,
    };
  }
}
