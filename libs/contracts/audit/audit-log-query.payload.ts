import { ICorrelationPayload } from '../microservices';

// The filter set for the `audit.entry.query` read of the `audit_log_entry` staff audit trail
// (docs/adr/039-audit-and-event-store-query-surface.md). Every field is optional and NARROWS
// the scan; an absent field contributes no predicate, so an empty filter lists the whole
// trail, newest-first.
//
// Every filter names an INDEXED column. There is deliberately no free-text or JSON-path
// search over the `before` / `after` snapshots (ADR-039).
//
// `from` / `to` bound `occurredAt` INCLUSIVELY. An inverted range (`from > to`) selects
// nothing and yields an empty page — the event store raises no domain exception for it.
export interface IAuditLogQueryFilters {
  // The acting staff principal's id. Null-actor rows (pre-auth / system-origin) are matched
  // by no value a caller can pass.
  actorId?: string;
  entityType?: string;
  entityId?: string;
  // The stable event-name classifier, e.g. `RefundIssued`, `StaffUserRolesAssigned`.
  action?: string;
  // Matches `audit_log_entry.correlation_id`, which — unlike its `domain_event` sibling — is
  // genuinely NULLABLE (the audit trail has no dedupe key). A `WHERE correlation_id = ?`
  // therefore never matches a null-correlation row.
  correlationId?: string;
  from?: string; // inclusive ISO-8601 lower bound on occurredAt
  to?: string; // inclusive ISO-8601 upper bound on occurredAt
}

// Wire-format query payload for `audit.entry.query` (API Gateway → event store).
//
// The filters are nested for the same reason its `domain_event` sibling nests them: the
// inherited `correlationId` is the *request's* trace id, while `filters.correlationId` is the
// id being searched for. Two unrelated meanings, two field positions.
//
// `page` is 1-based, `pageSize` is the page length; both optional (the use case clamps them:
// defaults 1 / 20, hard cap 100). The response is the canonical `IPage<AuditLogEntryView>`.
export interface IAuditLogQueryPayload extends ICorrelationPayload {
  filters: IAuditLogQueryFilters;
  page?: number;
  pageSize?: number;
}
