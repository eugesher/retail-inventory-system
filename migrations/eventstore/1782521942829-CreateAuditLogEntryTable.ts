import { MigrationInterface, QueryRunner } from 'typeorm';

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

    await queryRunner.query(
      'CREATE INDEX IDX_AUDIT_LOG_ENTRY_ACTOR ON audit_log_entry (actor_id, occurred_at DESC);',
    );
    await queryRunner.query(
      'CREATE INDEX IDX_AUDIT_LOG_ENTRY_ENTITY ON audit_log_entry (entity_type, entity_id, occurred_at DESC);',
    );
    await queryRunner.query(
      'CREATE INDEX IDX_AUDIT_LOG_ENTRY_ACTION ON audit_log_entry (action, occurred_at DESC);',
    );
    await queryRunner.query(
      'CREATE INDEX IDX_AUDIT_LOG_ENTRY_CORRELATION ON audit_log_entry (correlation_id);',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS audit_log_entry;');
  }
}
