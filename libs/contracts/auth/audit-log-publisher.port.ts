// The staff-action audit seam. `AUDIT_LOG_PUBLISHER` is bound to `AuditLogRabbitmqPublisher` in
// both services that raise audit events — the gateway's `auth` and retail's `orders` — and emits
// `audit.staff.action` onto the `ris.events` topic exchange, where the event store's firehose
// dispatches it to `audit_log_entry` rather than `domain_event` (ADR-035 / ADR-039).

export const AUDIT_LOG_PUBLISHER = Symbol('AUDIT_LOG_PUBLISHER');

export type AuditActorKind = 'staff' | 'customer' | 'anonymous';
export type AuditTargetKind = 'staff-user' | 'customer' | 'role' | 'permission';

export interface IAuditLogEvent {
  // Convention: a past-tense verb phrase — `UserLoggedIn`, `StaffUserRolesAssigned`, `RoleCreated`.
  //
  // **This string is what lands in `audit_log_entry.action`, and it is what an `?action=` query
  // filters on.** It is never a `PermissionCodeEnum` value: filtering the audit log by a
  // permission code is a well-formed query that matches nothing.
  name: string;

  // The acting subject, when there is one. Null for events raised before authentication resolves
  // (`LoginFailed: user not found`).
  actorId: string | null;

  // Which id space `actorId` belongs to. A consumer needs this because staff and customer ids are
  // NOT unique across the two — the id alone does not identify the actor.
  actorKind: AuditActorKind;

  // The target resource the event mutates (e.g., the StaffUser id whose
  // roles were assigned, the Role id whose permissions were replaced).
  // Null for events that don't mutate a specific resource (e.g., LoginFailed).
  targetId: string | null;
  targetKind: AuditTargetKind | null;

  // Free-form structured payload. Use camelCase keys. Keep it under ~1KB —
  // long payloads belong on the resource itself, not on the audit row.
  payload: Record<string, unknown>;

  // Propagated by `CorrelationMiddleware`; null outside a request context. A null here writes a
  // null `audit_log_entry.correlation_id`, and that row is then reachable by **no** correlation
  // filter and by no trace — a `WHERE correlation_id = ?` never matches it.
  correlationId: string | null;

  // Set by the publisher, not the caller. Pass one only when a deterministic timestamp is needed.
  occurredAt?: Date;
}

export interface IAuditLogPublisher {
  publish(event: IAuditLogEvent): Promise<void>;
}
