import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateDomainEventTable1782521938896 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE domain_event (
        id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        event_type      VARCHAR(64)  NOT NULL,
        aggregate_type  VARCHAR(32)  NOT NULL,
        aggregate_id    VARCHAR(64)  NOT NULL,
        payload         JSON         NOT NULL,
        event_version   VARCHAR(8)   NOT NULL,
        producer        VARCHAR(32)  NOT NULL,
        correlation_id  VARCHAR(64)  NOT NULL DEFAULT '',
        occurred_at     TIMESTAMP(3) NOT NULL,
        received_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        CONSTRAINT UC_DOMAIN_EVENT_IDEMPOTENCY
          UNIQUE (producer, event_type, aggregate_id, occurred_at, correlation_id)
      );
    `);

    await queryRunner.query(
      'CREATE INDEX IDX_DOMAIN_EVENT_AGGREGATE ON domain_event (aggregate_type, aggregate_id, occurred_at DESC);',
    );
    await queryRunner.query(
      'CREATE INDEX IDX_DOMAIN_EVENT_TYPE ON domain_event (event_type, occurred_at DESC);',
    );
    await queryRunner.query(
      'CREATE INDEX IDX_DOMAIN_EVENT_CORRELATION ON domain_event (correlation_id);',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS domain_event;');
  }
}
