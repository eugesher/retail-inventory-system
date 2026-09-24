export const AUDIT_LOG_PUBLISHER = Symbol('AUDIT_LOG_PUBLISHER');

export type AuditActorKind = 'staff' | 'customer' | 'anonymous';
export type AuditTargetKind = 'staff-user' | 'customer' | 'role' | 'permission';

export interface IAuditLogEvent {
  name: string;

  actorId: string | null;

  actorKind: AuditActorKind;

  targetId: string | null;
  targetKind: AuditTargetKind | null;

  payload: Record<string, unknown>;

  correlationId: string | null;

  occurredAt?: Date;
}

export interface IAuditLogPublisher {
  publish(event: IAuditLogEvent): Promise<void>;
}
