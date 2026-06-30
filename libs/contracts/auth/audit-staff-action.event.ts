import { ICorrelationPayload } from '../microservices';
import { IAuditLogEvent } from './audit-log-publisher.port';

// The wire contract for the cross-cutting staff-action audit stream (ADR-035).
//
// Emitted onto the `ris.events` topic exchange under the `audit.staff.action`
// routing key by the real `AUDIT_LOG_PUBLISHER` adapters (api-gateway `auth` and
// retail `orders`) and consumed only by the event store's audit-log ingest, which
// persists it to `audit_log_entry`. It is the on-the-wire projection of the
// in-process `IAuditLogEvent` (see `audit-log-publisher.port.ts`): a stable,
// transport-shaped record decoupled from the richer domain event so the event
// store never imports a producer's internal types.
//
// Field mapping the adapters apply (`IAuditLogEvent` → this shape):
//   action     ← event.name                                   (the stable event-name string)
//   actorType  ← event.actorKind === 'staff' ? 'staff-user' : 'system'
//   entityType ← event.targetKind                             (nullable)
//   entityId   ← event.targetId                               (nullable)
//   before     ← event.payload.before ?? null
//   after      ← event.payload.after  ?? (event.payload ?? null)
//   occurredAt ← (event.occurredAt ?? new Date()).toISOString()
//   ipAddress  ← null                                         (no IP captured at call sites today)
export interface IAuditStaffActionEvent extends ICorrelationPayload {
  // The acting subject's id, or null for pre-auth / system-origin events.
  actorId: string | null;

  // `staff-user` for a staff actor; `system` for everything else (customer,
  // anonymous, or an unattributed background mutation such as the
  // auto-refund-from-cancel path). The audit log keeps these two origin classes
  // distinct because actor ids are not globally unique across id spaces.
  actorType: 'staff-user' | 'system';

  // The stable event-name string (`IAuditLogEvent.name`) — e.g.
  // 'StaffUserRolesAssigned', 'RefundIssued'. The audit log's primary classifier.
  action: string;

  // The mutated resource's kind/id when the event targets one specific resource;
  // both null for events that mutate nothing specific (e.g. 'LoginFailed').
  entityType: string | null;
  entityId: string | null;

  // The before/after state snapshots when the call site supplies them; otherwise
  // `after` carries the whole structured payload and `before` is null.
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;

  // ISO-8601 instant the action occurred.
  occurredAt: string;

  // The originating client IP — always null today (no call site captures it; a
  // documented gap to close when audit endpoints thread the request IP through).
  ipAddress: string | null;

  // Pins the wire shape so the ingest can branch on a schema bump without guessing.
  eventVersion: 'v1';
}

// Maps the in-process `IAuditLogEvent` onto the `IAuditStaffActionEvent` wire shape
// (the field table documented above). Pure and transport-free so BOTH real
// `AUDIT_LOG_PUBLISHER` adapters (api-gateway `auth`, retail `orders`) share this one
// mapping instead of each carrying a byte-identical private `toWire` copy that must be
// kept in lockstep. `before`/`after`: explicit payload keys win; otherwise the whole
// payload becomes `after` and `before` is null. `ipAddress` is always null (no call site
// captures it today); `occurredAt` defaults to now when the event omits it.
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
