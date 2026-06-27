import { MigrationInterface, QueryRunner } from 'typeorm';

// Creates the `audit_log_entry` table — the append-only staff audit trail (WHO did
// WHAT, WHEN), captured from the cross-cutting `audit.staff.action` stream on the
// `ris.events` topic exchange (docs/adr/035-event-store-firehose-topic-exchange.md). It
// is the persisted shape of the wire `IAuditStaffActionEvent`. Like its `domain_event`
// sibling it lives in the ISOLATED `ris_eventstore` schema
// (docs/adr/034-isolated-eventstore-database.md) and runs under the eventstore
// data-source (`migration:run:eventstore`).
//
// The trail is APPEND-ONLY for audit integrity — an editable or deletable audit row is
// no audit at all — so, deliberately, there are NO `updated_at` / `deleted_at` columns
// (the repository exposes only `append` + reads via `insert`). `occurred_at` is the
// action time; `received_at` is the DB-assigned ingest instant; both TIMESTAMP(3).
//
// `actor_type` is a two-value ENUM (`staff-user` for a real staff principal, `system`
// for everything else — customer/anonymous/unattributed background mutations; actor
// ids are not globally unique across those id spaces). `before` / `after` are JSON
// state snapshots, both nullable (many events carry neither). `ip_address` is sized for
// an IPv6 literal but always null today (no call site threads the request IP — a
// documented gap, ADR-035). `before` and `after` are BACKTICKED — `BEFORE` is a MySQL
// reserved word (the `return_line.condition` precedent). Audit has no natural dedupe
// key, so there is NO UNIQUE constraint — the BIGINT PK autoincrements per entry.
//
// The four indexes back the future audit query paths: by actor, by mutated entity, by
// action classifier, and by correlation. No FK on any column (the isolated schema
// references nothing).
export class CreateAuditLogEntryTable1782521942829 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE audit_log_entry (
        id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        actor_id        VARCHAR(64)  NULL,
        actor_type      ENUM('staff-user','system') NOT NULL,
        action          VARCHAR(64)  NOT NULL,
        entity_type     VARCHAR(32)  NULL,
        entity_id       VARCHAR(64)  NULL,
        \`before\`        JSON         NULL,
        \`after\`         JSON         NULL,
        occurred_at     TIMESTAMP(3) NOT NULL,
        ip_address      VARCHAR(45)  NULL,
        correlation_id  VARCHAR(64)  NULL,
        received_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      );
    `);

    // "What has this staff member done, newest first?"
    await queryRunner.query(
      'CREATE INDEX IDX_AUDIT_LOG_ENTRY_ACTOR ON audit_log_entry (actor_id, occurred_at DESC);',
    );
    // "What was done to this resource, newest first?"
    await queryRunner.query(
      'CREATE INDEX IDX_AUDIT_LOG_ENTRY_ENTITY ON audit_log_entry (entity_type, entity_id, occurred_at DESC);',
    );
    // "Every occurrence of this action, newest first."
    await queryRunner.query(
      'CREATE INDEX IDX_AUDIT_LOG_ENTRY_ACTION ON audit_log_entry (action, occurred_at DESC);',
    );
    // The cross-service-trace join.
    await queryRunner.query(
      'CREATE INDEX IDX_AUDIT_LOG_ENTRY_CORRELATION ON audit_log_entry (correlation_id);',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS audit_log_entry;');
  }
}
