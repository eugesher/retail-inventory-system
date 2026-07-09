import { IAuditLogQueryFilters, IPage } from '@retail-inventory-system/contracts';

import { AuditLogEntry } from '../../domain';

export const AUDIT_LOG_REPOSITORY = Symbol('AUDIT_LOG_REPOSITORY');

// The applied page window. Pagination is declared LOCALLY here rather than imported from
// `libs/common`'s `IPageRequest` — an `application-port` may not depend on `lib-common`
// (the `eslint-plugin-boundaries` rule, ADR-017), so the port owns its own page-request
// shape (the `INotificationDeliveryPageRequest` precedent). It is structurally identical to
// `clampPageWindow`'s return value, which is what the query use case passes. `page` is
// 1-based.
export interface IAuditLogPageRequest {
  page: number;
  size: number;
}

// The ENTIRE repository surface for the staff audit trail — `append` + the two reads, and
// NOTHING else. There is deliberately no `save` / `update` / `delete`: the `audit_log_entry`
// log is append-only (audit integrity — an editable audit row is no audit at all), enforced
// HERE in the type surface, not by convention. Domain types only — no `typeorm` leak
// (ADR-017).
export interface IAuditLogRepositoryPort {
  // INSERT an audit entry and let the BIGINT PK autoincrement. Unlike the firehose log
  // there is no idempotency key to collide on (every staff action is its own event, even
  // two identical actions a second apart), so the insert always succeeds — there is no
  // `{ inserted }` outcome to report, hence `void`.
  append(entry: AuditLogEntry): Promise<void>;

  // The paginated, filtered audit read (ADR-039). Ordering is owned HERE: `occurred_at DESC,
  // id DESC` — newest-first, because an operator asking "what has this staff member done"
  // wants the latest first; the `id` tiebreaker totalises the order within a millisecond.
  // Every supplied filter contributes one predicate over an INDEXED column; an absent filter
  // contributes none. `from` / `to` bound `occurred_at` inclusively, and an inverted range
  // simply selects nothing.
  query(filters: IAuditLogQueryFilters, page: IAuditLogPageRequest): Promise<IPage<AuditLogEntry>>;

  // The correlation TRACE read: every audit row belonging to one request's causal chain,
  // ordered `occurred_at ASC, id ASC`.
  //
  // Deliberately UNPAGINATED and ASCENDING, and therefore not expressible as a call to
  // `query` above. A correlation id scopes exactly one request, so the result set is bounded
  // and small — there is nothing to page — and a timeline reads FORWARD, the opposite of the
  // newest-first order every other audit read wants.
  //
  // `audit_log_entry.correlation_id` is nullable (the trail has no dedupe key), so a
  // null-correlation row is matched by no id and appears in no trace. An unknown id yields
  // `[]`, never an error.
  listByCorrelationId(correlationId: string): Promise<AuditLogEntry[]>;
}
