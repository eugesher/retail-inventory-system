import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateRefundTable1781859356461 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE refund (
        id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        order_id          BIGINT UNSIGNED NOT NULL,
        payment_id        BIGINT UNSIGNED NOT NULL,
        amount_minor      BIGINT       NOT NULL,
        currency          CHAR(3)      NOT NULL,
        status            ENUM('pending','issued','failed') NOT NULL DEFAULT 'pending',
        reason            VARCHAR(255) NOT NULL,
        gateway_reference VARCHAR(255) NULL,
        issued_at         TIMESTAMP    NULL,
        created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at        TIMESTAMP    NULL,
        CONSTRAINT FK_REFUND_ORDER FOREIGN KEY (order_id)
          REFERENCES \`order\` (id) ON DELETE RESTRICT,
        CONSTRAINT FK_REFUND_PAYMENT FOREIGN KEY (payment_id)
          REFERENCES payment (id) ON DELETE RESTRICT
      ) COLLATE = utf8mb4_unicode_ci;
    `);
    await queryRunner.query('CREATE INDEX IDX_REFUND_ORDER ON refund (order_id);');
    await queryRunner.query('CREATE INDEX IDX_REFUND_PAYMENT ON refund (payment_id);');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS refund;');
  }
}
