import { ICorrelationPayload } from '../microservices';
import { IAuditLogEvent } from './audit-log-publisher.port';

// The wire shape of the `audit.staff.action` stream (ADR-035) — the on-the-wire projection of the
// in-process `IAuditLogEvent`, kept separate so the event store never imports a producer's
// internal types. `toAuditStaffActionEvent` below is the mapping; it is not restated here.
export interface IAuditStaffActionEvent extends ICorrelationPayload {
  actorId: string | null;

  // **Only a staff actor gets `staff-user`.** A customer's action, an anonymous one, and an
  // unattributed background mutation (the auto-refund-from-cancel path) all land as `system` —
  // the two values are origin *classes*, not a staff/not-staff flag, and `system` is where three
  // very different things collapse together. Reading the log as "who did it" needs `actorId` too,
  // which is not unique across the staff and customer id spaces.
  actorType: 'staff-user' | 'system';

  // The audit log's primary classifier, and what an `?action=` filter matches. It is
  // `IAuditLogEvent.name` — `StaffUserRolesAssigned`, `RefundIssued` — and **never** a
  // `PermissionCodeEnum` value.
  action: string;

  entityType: string | null;
  entityId: string | null;

  // **`after` is not reliably an "after state".** When the call site supplies explicit
  // `before`/`after` keys they win; otherwise the *whole* payload becomes `after` and `before` is
  // null. A consumer diffing the two will diff a state against a nothing.
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;

  occurredAt: string;

  // **Structurally always `null`** — the mapper hardcodes it, because no call site captures a
  // request IP. Querying the audit log by IP returns nothing, and will keep doing so until a call
  // site threads one through.
  ipAddress: string | null;

  eventVersion: 'v1';
}

// The one mapping, shared by both `AUDIT_LOG_PUBLISHER` adapters rather than copied into each
// (ADR-043). Pure and transport-free, so it lives in `contracts` beside the shape it produces.
//
// **A missing `correlationId` becomes `''`, not `null`** — forced by the wire type, since
// `ICorrelationPayload.correlationId` is a non-nullable `string` while `IAuditLogEvent`'s is
// nullable. The `audit_log_entry` column would happily take a `null`; it never sees one.
//
// Either way the row is unfindable: an audit event raised outside a request context matches **no**
// correlation filter and appears in **no** trace. It is not lost — it is invisible to the one key
// anyone would search on.
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
