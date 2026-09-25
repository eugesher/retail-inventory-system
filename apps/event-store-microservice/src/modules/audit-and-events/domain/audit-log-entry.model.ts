export type AuditActorType = 'staff-user' | 'system';

export const AUDIT_ACTOR_TYPES: readonly AuditActorType[] = ['staff-user', 'system'];

export interface IAuditLogEntryProps {
  id: number | null;
  actorId: string | null;
  actorType: AuditActorType;
  action: string;
  entityType: string | null;
  entityId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  occurredAt: Date;
  ipAddress: string | null;
  correlationId: string | null;
}

export interface ICreateAuditLogEntryProps {
  actorId?: string | null;
  actorType: AuditActorType;
  action: string;
  entityType?: string | null;
  entityId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  occurredAt: Date;
  ipAddress?: string | null;
  correlationId?: string | null;
}

export class AuditLogEntry {
  public readonly id: number | null;
  public readonly actorId: string | null;
  public readonly actorType: AuditActorType;
  public readonly action: string;
  public readonly entityType: string | null;
  public readonly entityId: string | null;
  public readonly before: Record<string, unknown> | null;
  public readonly after: Record<string, unknown> | null;
  public readonly occurredAt: Date;
  public readonly ipAddress: string | null;
  public readonly correlationId: string | null;

  private constructor(props: IAuditLogEntryProps) {
    AuditLogEntry.requireNonEmpty(props.action, 'action');
    AuditLogEntry.requireKnownActorType(props.actorType);

    this.id = props.id;
    this.actorId = props.actorId;
    this.actorType = props.actorType;
    this.action = props.action;
    this.entityType = props.entityType;
    this.entityId = props.entityId;
    this.before = props.before;
    this.after = props.after;
    this.occurredAt = props.occurredAt;
    this.ipAddress = props.ipAddress;
    this.correlationId = props.correlationId;

    Object.freeze(this);
  }

  public static create(props: ICreateAuditLogEntryProps): AuditLogEntry {
    return new AuditLogEntry({
      id: null,
      actorId: props.actorId ?? null,
      actorType: props.actorType,
      action: props.action,
      entityType: props.entityType ?? null,
      entityId: props.entityId ?? null,
      before: props.before ?? null,
      after: props.after ?? null,
      occurredAt: props.occurredAt,
      ipAddress: props.ipAddress ?? null,
      correlationId: props.correlationId ?? null,
    });
  }

  public static reconstitute(props: IAuditLogEntryProps): AuditLogEntry {
    return new AuditLogEntry(props);
  }

  private static requireNonEmpty(value: string, field: string): void {
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`AuditLogEntry: ${field} must be a non-empty string`);
    }
  }

  private static requireKnownActorType(actorType: AuditActorType): void {
    if (!AUDIT_ACTOR_TYPES.includes(actorType)) {
      throw new Error(
        `AuditLogEntry: actorType must be one of ${AUDIT_ACTOR_TYPES.join(', ')}, got ${String(actorType)}`,
      );
    }
  }
}
