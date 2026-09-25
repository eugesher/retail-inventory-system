import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePaymentTable1781187655857 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE payment (
        id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        order_id          BIGINT UNSIGNED NOT NULL,
        amount_minor      BIGINT       NOT NULL,
        currency          CHAR(3)      NOT NULL,
        method            VARCHAR(64)  NOT NULL,
        status            ENUM('authorized','captured','voided','refunded','failed') NOT NULL,
        gateway_reference VARCHAR(255) NOT NULL,
        authorized_at     TIMESTAMP    NULL,
        captured_at       TIMESTAMP    NULL,
        created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at        TIMESTAMP    NULL,
        CONSTRAINT UC_PAYMENT_GATEWAY_REFERENCE UNIQUE (gateway_reference),
        CONSTRAINT FK_PAYMENT_ORDER FOREIGN KEY (order_id)
          REFERENCES \`order\` (id) ON DELETE RESTRICT
      ) COLLATE = utf8mb4_unicode_ci;
    `);
    await queryRunner.query('CREATE INDEX IDX_PAYMENT_ORDER ON payment (order_id);');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS payment;');
  }
}
