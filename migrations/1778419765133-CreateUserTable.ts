import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateUserTable1778419765133 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE user (
        id                 CHAR(36)     NOT NULL PRIMARY KEY,
        email              VARCHAR(255) NOT NULL,
        password_hash      VARCHAR(255) NOT NULL,
        roles              VARCHAR(255) NOT NULL DEFAULT 'customer',
        refresh_token_hash VARCHAR(255) NULL,
        created_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at         TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        deleted_at         TIMESTAMP    NULL,
        CONSTRAINT UC_USER_EMAIL UNIQUE (email)
      )
        COLLATE = utf8mb4_unicode_ci;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE user;');
  }
}
