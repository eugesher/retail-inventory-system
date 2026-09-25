import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateIdempotencyKeyTable1782825610025 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE idempotency_key (
        scope               VARCHAR(64) NOT NULL,
        \`key\`               VARCHAR(64) NOT NULL,
        request_fingerprint CHAR(64)    NOT NULL,
        response_status     INT         NULL,
        response_body       JSON        NULL,
        created_at          TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expires_at          TIMESTAMP   NOT NULL,
        PRIMARY KEY (scope, \`key\`)
      ) COLLATE = utf8mb4_unicode_ci;
    `);
    await queryRunner.query(
      'CREATE INDEX IDX_IDEMPOTENCY_KEY_EXPIRES_AT ON idempotency_key (expires_at);',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS idempotency_key;');
  }
}
