import { ICorrelationPayload } from '../microservices';
import { IAuditLogEvent } from './audit-log-publisher.port';

export interface IAuditStaffActionEvent extends ICorrelationPayload {
  actorId: string | null;

  actorType: 'staff-user' | 'system';

  action: string;

  entityType: string | null;
  entityId: string | null;

  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;

  occurredAt: string;

  ipAddress: string | null;

  eventVersion: 'v1';
}

export function toAuditStaffActionEvent(event: IAuditLogEvent): IAuditStaffActionEvent {
  const before = (event.payload.before as Record<string, unknown> | undefined) ?? null;
  const after =
    (event.payload.after as Record<string, unknown> | undefined) ?? event.payload ?? null;

  return {
    actorId: event.actorId,
    actorType: event.actorKind === 'staff' ? 'staff-user' : 'system',
    action: event.name,
    entityType: event.targetKind,
    entityId: event.targetId,
    before,
    after,
    occurredAt: (event.occurredAt ?? new Date()).toISOString(),
    ipAddress: null,
    correlationId: event.correlationId ?? '',
    eventVersion: 'v1',
  };
}
