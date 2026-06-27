import { AuditLogEntry } from '../../domain';

export const AUDIT_LOG_REPOSITORY = Symbol('AUDIT_LOG_REPOSITORY');

// The outcome of an append. Audit entries have no natural dedupe key in this
// capability (every staff action is its own event, even two identical actions a second
// apart), so the BIGINT PK autoincrements and `inserted` is always `true` on success.
// The `{ inserted }` shape mirrors the domain-event port so a later capability could
// add a dedupe key without changing the signature.
export interface IAuditLogAppendResult {
  inserted: boolean;
}

// The ENTIRE repository surface for the staff audit trail — `append` plus the future
// read, and NOTHING else. There is deliberately no `save` / `update` / `delete`: the
// `audit_log_entry` log is append-only (audit integrity — an editable audit row is no
// audit at all), enforced HERE in the type surface, not by convention. Domain types
// only — no `typeorm` leak (ADR-017).
export interface IAuditLogRepositoryPort {
  // INSERT an audit entry and let the BIGINT PK autoincrement. Unlike the firehose
  // log there is no idempotency key to collide on, so a success always reports
  // `{ inserted: true }`.
  append(entry: AuditLogEntry): Promise<IAuditLogAppendResult>;

  // Newest-first entries for one actor — the future "what has this staff member done?"
  // audit read, backed by the `(actor_id, occurred_at DESC)` index. Declared now so the
  // seam is complete (the `StockMovement.listByVariant` precedent); a read, so the
  // append-only invariant is untouched. No HTTP/RPC endpoint is built against it here.
  listByActor(actorId: string): Promise<AuditLogEntry[]>;
}
