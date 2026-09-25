import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCustomerTable1779906269812 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `order` DROP FOREIGN KEY FK_ORDER_CUSTOMER;');
    await queryRunner.query('ALTER TABLE `order` DROP COLUMN customer_id;');
    await queryRunner.query('DROP TABLE customer;');

    await queryRunner.query(`
      CREATE TABLE customer (
        id                  CHAR(36)                                              NOT NULL PRIMARY KEY,
        email               VARCHAR(255)                                          NOT NULL,
        phone               VARCHAR(32)                                           NULL,
        first_name          VARCHAR(128)                                          NULL,
        last_name           VARCHAR(128)                                          NULL,
        password_hash       VARCHAR(255)                                          NULL,
        status              ENUM('active', 'suspended', 'guest', 'deleted')       NOT NULL DEFAULT 'active',
        email_verified_at   TIMESTAMP                                             NULL,
        refresh_token_hash  VARCHAR(255)                                          NULL,
        created_at          TIMESTAMP                                             NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at          TIMESTAMP                                             NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT UC_CUSTOMER_EMAIL UNIQUE (email)
      )
        COLLATE = utf8mb4_unicode_ci;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE customer;');
    await queryRunner.query(`
      CREATE TABLE customer (
        id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        email      VARCHAR(255) NOT NULL,
        first_name VARCHAR(100) NULL,
        last_name  VARCHAR(100) NULL,
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT UC_CUSTOMER_EMAIL UNIQUE (email)
      );
    `);
    await queryRunner.query('ALTER TABLE `order` ADD COLUMN customer_id BIGINT UNSIGNED NOT NULL;');
    await queryRunner.query(`
      ALTER TABLE \`order\`
        ADD CONSTRAINT FK_ORDER_CUSTOMER FOREIGN KEY (customer_id)
          REFERENCES customer (id);
    `);
  }
}
