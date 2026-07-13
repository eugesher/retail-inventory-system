import { AuditLogEntryView } from '@retail-inventory-system/contracts';

import { AuditLogEntry } from '../../domain';

// Pure mapping from the frozen `AuditLogEntry` record onto the wire `AuditLogEntryView`
// (ADR-039). Kept framework-free so the projection lives in exactly one place — the
// `toNotificationDeliveryView` factory pattern — and is shared by both audit reads (the
// paginated query and the correlation trace).
//
// The record is always persisted when it reaches the factory, so `id` is concrete — the `!`
// reflects that invariant. `occurredAt` becomes an ISO-8601 string: a `Date` does not survive
// the RabbitMQ JSON hop intact.
//
// Every nullable field is passed through unchanged: `actorId` is genuinely null for a
// system-origin row, `ipAddress` is null for every row today (no call site threads the
// request IP — a documented gap, ADR-035), and `correlationId` is null for a row published
// without one.
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
