// One immutable row of the staff audit trail: WHO did WHAT, WHEN
// (docs/adr/035-event-store-firehose-topic-exchange.md). The `audit-log` module sinks
// the cross-cutting `audit.staff.action` stream — distinct from the raw event firehose
// the sibling `domain-events/` module captures — into the append-only
// `audit_log_entry` table. This model is the persisted shape of the wire
// `IAuditStaffActionEvent` (libs/contracts/auth), plus the DB-assigned `id`.
//
// Framework-free per ADR-004, and a fully **immutable** record in the `StockMovement`
// ledger style (ADR-030 §2): every field is `public readonly`, the constructed
// instance is `Object.freeze`-d, there are NO mutators and NO domain events, and it is
// NOT an `AggregateRoot`. Audit integrity demands append-only — an audit row that could
// be edited or deleted is no audit at all — so the immutability starts in the type
// system.
//
// The model accepts whatever the bus carries (every nullable field genuinely arrives
// null for some events — e.g. `LoginFailed` has no actor, `ipAddress` is always null
// today). The only invariants enforced are the two the column types make load-bearing:
// a non-empty `action` (the audit log's primary classifier) and an `actorType` that is
// one of the two known origin classes. A violation is an INTERNAL caller bug (the
// ingest use case shapes the row first), so it throws a plain `Error`, not a typed
// domain exception.

// The two origin classes the audit log keeps distinct: a real staff principal vs.
// everything else (customer, anonymous, or an unattributed background mutation such as
// the auto-refund-from-cancel path). Actor ids are not globally unique across those id
// spaces, so the class disambiguates them. Mirrors `IAuditStaffActionEvent.actorType`;
// kept as a domain-local union (the wire carries the raw string) rather than a
// `libs/contracts` enum, the `ReservationStatusEnum` placement precedent (ADR-030).
export type AuditActorType = 'staff-user' | 'system';

export const AUDIT_ACTOR_TYPES: readonly AuditActorType[] = ['staff-user', 'system'];

// Full reconstruction shape (the load path). `create` derives `id` and defaults every
// optional nullable field, so its input is the narrower `ICreateAuditLogEntryProps`.
export interface IAuditLogEntryProps {
  id: number | null;
  actorId: string | null;
  actorType: AuditActorType;
  action: string;
  entityType: string | null;
  entityId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  // The instant the action occurred (the producer's time); `received_at` is the
  // separate DB-assigned ingest instant, not modelled here.
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
    // The two load-bearing invariants. A row with no action classifies nothing; an
    // unknown actor type would silently widen the two-value origin axis. Both are
    // INTERNAL caller bugs (the ingest use case validates the wire shape first) — plain
    // `Error`s, not typed exceptions.
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

    // The runtime half of append-only-in-the-type-system: a frozen instance rejects any
    // post-construction write (the `StockMovement` precedent).
    Object.freeze(this);
  }

  // The write path: a fresh entry with `id: null` (DB-assigned on append) and every
  // optional nullable field defaulting to null when omitted.
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

  // The load path: rebuilds a persisted entry from storage; the invariants are
  // re-asserted on read.
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
