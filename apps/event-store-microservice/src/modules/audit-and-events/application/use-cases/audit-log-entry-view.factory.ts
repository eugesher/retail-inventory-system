import { AuditLogEntryView } from '@retail-inventory-system/contracts';

import { AuditLogEntry } from '../../domain';

export const toAuditLogEntryView = (entry: AuditLogEntry): AuditLogEntryView => ({
  id: entry.id!,
  actorId: entry.actorId,
  actorType: entry.actorType,
  action: entry.action,
  entityType: entry.entityType,
  entityId: entry.entityId,
  before: entry.before,
  after: entry.after,
  occurredAt: entry.occurredAt.toISOString(),
  ipAddress: entry.ipAddress,
  correlationId: entry.correlationId,
});
