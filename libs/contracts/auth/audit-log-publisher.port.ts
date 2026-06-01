// Forward-compatibility port for future audit-log delivery work.
// This baseline ships the interface + a no-op default adapter (Pino debug line) so
// every audit-relevant use case calls `publisher.publish(...)` today; that future work
// swaps the adapter binding to an RMQ publisher without re-touching call sites.

export const AUDIT_LOG_PUBLISHER = Symbol('AUDIT_LOG_PUBLISHER');

export type AuditActorKind = 'staff' | 'customer' | 'anonymous';
export type AuditTargetKind = 'staff-user' | 'customer' | 'role' | 'permission';

export interface IAuditLogEvent {
  // Stable event-name string. Convention: <past-tense verb phrase>.
  // Examples: 'UserLoggedIn', 'StaffUserRolesAssigned', 'RoleCreated'.
  name: string;

  // The subject acting (StaffUser/Customer id) when known. Null for events
  // produced before authentication (e.g., 'LoginFailed: user not found').
  actorId: string | null;

  // The kind of subject acting. Audit consumers need this because actor ids
  // are not globally unique across the two id spaces in this baseline.
  actorKind: AuditActorKind;

  // The target resource the event mutates (e.g., the StaffUser id whose
  // roles were assigned, the Role id whose permissions were replaced).
  // Null for events that don't mutate a specific resource (e.g., LoginFailed).
  targetId: string | null;
  targetKind: AuditTargetKind | null;

  // Free-form structured payload. Use camelCase keys. Keep it under ~1KB —
  // long payloads belong on the resource itself, not on the audit row.
  payload: Record<string, unknown>;

  // Correlation id from `request.headers['x-correlation-id']` (propagated by
  // `CorrelationMiddleware`). Null when called outside a request context.
  correlationId: string | null;

  // Always set by the publisher implementation, not the caller — the caller
  // can pass it through if a deterministic timestamp is needed (rare).
  occurredAt?: Date;
}

export interface IAuditLogPublisher {
  publish(event: IAuditLogEvent): Promise<void>;
}
