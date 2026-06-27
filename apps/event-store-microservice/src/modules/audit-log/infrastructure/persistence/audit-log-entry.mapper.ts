import { DeepPartial } from 'typeorm';

import { AuditLogEntry } from '../../domain';
import { AuditLogEntryEntity } from './audit-log-entry.entity';

export class AuditLogEntryMapper {
  public static toDomain(entity: AuditLogEntryEntity): AuditLogEntry {
    return AuditLogEntry.reconstitute({
      // The BIGINT PK comes back from the mysql2 driver as a string; coerce to a
      // number (the `StockMovementMapper` precedent, ADR-019).
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
    // `id` (DB-assigned) and `received_at` (DB-defaulted ingest instant) are omitted —
    // written by the database, never the mapper. There is no update path: an audit
    // entry is immutable once appended.
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
