import { AuditLogEntry } from '../../domain';

export const AUDIT_LOG_REPOSITORY = Symbol('AUDIT_LOG_REPOSITORY');

// The ENTIRE repository surface for the staff audit trail — `append`, and NOTHING else.
// There is deliberately no `save` / `update` / `delete`: the `audit_log_entry` log is
// append-only (audit integrity — an editable audit row is no audit at all), enforced
// HERE in the type surface, not by convention. Domain types only — no `typeorm` leak
// (ADR-017).
export interface IAuditLogRepositoryPort {
  // INSERT an audit entry and let the BIGINT PK autoincrement. Unlike the firehose log
  // there is no idempotency key to collide on (every staff action is its own event, even
  // two identical actions a second apart), so the insert always succeeds — there is no
  // `{ inserted }` outcome to report, hence `void`.
  append(entry: AuditLogEntry): Promise<void>;
}
