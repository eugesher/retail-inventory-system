import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddConsentAndTombstoneColumns1783145019567 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE consent_record (
        customer_id           CHAR(36)     NOT NULL PRIMARY KEY,
        transactional_email   TINYINT(1)   NOT NULL DEFAULT 1,
        marketing_email       TINYINT(1)   NOT NULL DEFAULT 0,
        marketing_sms         TINYINT(1)   NOT NULL DEFAULT 0,
        data_retention_policy VARCHAR(32)  NOT NULL DEFAULT 'default-7-years',
        updated_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT FK_CONSENT_RECORD_CUSTOMER FOREIGN KEY (customer_id)
          REFERENCES customer (id) ON DELETE CASCADE
      ) COLLATE = utf8mb4_unicode_ci;
    `);

    await queryRunner.query('ALTER TABLE customer ADD COLUMN deleted_at TIMESTAMP NULL;');
    await queryRunner.query('ALTER TABLE customer MODIFY email VARCHAR(255) NULL;');

    await queryRunner.query('ALTER TABLE address MODIFY recipient_name VARCHAR(255) NULL;');
    await queryRunner.query('ALTER TABLE address MODIFY line1 VARCHAR(255) NULL;');
    await queryRunner.query('ALTER TABLE address MODIFY city VARCHAR(128) NULL;');
    await queryRunner.query('ALTER TABLE address MODIFY region VARCHAR(128) NULL;');
    await queryRunner.query('ALTER TABLE address MODIFY postal_code VARCHAR(32) NULL;');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE address MODIFY postal_code VARCHAR(32) NOT NULL;');
    await queryRunner.query('ALTER TABLE address MODIFY region VARCHAR(128) NOT NULL;');
    await queryRunner.query('ALTER TABLE address MODIFY city VARCHAR(128) NOT NULL;');
    await queryRunner.query('ALTER TABLE address MODIFY line1 VARCHAR(255) NOT NULL;');
    await queryRunner.query('ALTER TABLE address MODIFY recipient_name VARCHAR(255) NOT NULL;');

    await queryRunner.query('ALTER TABLE customer MODIFY email VARCHAR(255) NOT NULL;');
    await queryRunner.query('ALTER TABLE customer DROP COLUMN deleted_at;');

    await queryRunner.query('DROP TABLE IF EXISTS consent_record;');
  }
}
