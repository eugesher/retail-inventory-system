import { ApiResponseProperty } from '@nestjs/swagger';

// RPC/HTTP response shape for one `audit_log_entry` row — the append-only staff audit trail
// the event store fills from the `audit.staff.action` stream
// (docs/adr/035-event-store-firehose-topic-exchange.md). Returned by the `audit.entry.query`
// RPC and by the correlation trace (docs/adr/039-audit-and-event-store-query-surface.md).
//
// A **class** carrying `@ApiResponseProperty` (the documented lib-contracts Swagger exception,
// ADR-017), mirroring `NotificationDeliveryView`. It is the read counterpart of the write-side
// `IAuditStaffActionEvent` (libs/contracts/auth): the same fields, plus the DB-assigned `id`.
// `occurredAt` is an ISO-8601 string for the same reason it is one there — a `Date` does not
// survive the JSON hop.
//
// Unlike its `domain_event` sibling, `correlationId` here is genuinely nullable: the audit
// trail has no dedupe key, so nothing forced the column non-null. A row with a null
// correlation id is matched by no correlation filter and appears in no trace.
export class AuditLogEntryView {
  @ApiResponseProperty()
  public id: number;

  // Null for pre-auth / system-origin rows (a failed login, an unattributed background
  // mutation such as the auto-refund-from-cancel path).
  @ApiResponseProperty()
  public actorId: string | null;

  // `staff-user` for a real staff principal; `system` for everything else. Actor ids are not
  // globally unique across those id spaces, so the class disambiguates them.
  @ApiResponseProperty()
  public actorType: 'staff-user' | 'system';

  // The stable event-name classifier, e.g. `RefundIssued`, `StaffUserRolesAssigned`.
  @ApiResponseProperty()
  public action: string;

  @ApiResponseProperty()
  public entityType: string | null;

  @ApiResponseProperty()
  public entityId: string | null;

  // Opaque JSON state snapshots, returned verbatim and NOT searchable (ADR-039). `type: Object`
  // because Swagger cannot infer a schema for an index-signature type.
  @ApiResponseProperty({ type: Object })
  public before: Record<string, unknown> | null;

  @ApiResponseProperty({ type: Object })
  public after: Record<string, unknown> | null;

  @ApiResponseProperty()
  public occurredAt: string;

  // Always null today — no call site threads the request IP through (a documented gap,
  // ADR-035).
  @ApiResponseProperty()
  public ipAddress: string | null;

  @ApiResponseProperty()
  public correlationId: string | null;
}
