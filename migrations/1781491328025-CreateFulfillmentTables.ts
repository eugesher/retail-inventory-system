import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateFulfillmentTables1781491328025 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE fulfillment (
        id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        order_id          BIGINT UNSIGNED NOT NULL,
        stock_location_id VARCHAR(64)  NOT NULL,
        status            ENUM('pending','shipped','delivered','cancelled') NOT NULL DEFAULT 'pending',
        tracking_number   VARCHAR(64)  NULL,
        carrier           VARCHAR(64)  NULL,
        shipped_at        TIMESTAMP    NULL,
        delivered_at      TIMESTAMP    NULL,
        version           INT          NOT NULL DEFAULT 0,
        created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at        TIMESTAMP    NULL,
        CONSTRAINT FK_FULFILLMENT_ORDER FOREIGN KEY (order_id)
          REFERENCES \`order\` (id) ON DELETE RESTRICT
      ) COLLATE = utf8mb4_unicode_ci;
    `);
    await queryRunner.query(
      'CREATE INDEX IDX_FULFILLMENT_ORDER_SHIPPED ON fulfillment (order_id, shipped_at);',
    );

    await queryRunner.query(`
      CREATE TABLE fulfillment_line (
        id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        fulfillment_id BIGINT UNSIGNED NOT NULL,
        order_line_id  BIGINT UNSIGNED NOT NULL,
        quantity       INT          NOT NULL,
        created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at     TIMESTAMP    NULL,
        CONSTRAINT FK_FULFILLMENT_LINE_FULFILLMENT FOREIGN KEY (fulfillment_id)
          REFERENCES fulfillment (id) ON DELETE CASCADE,
        CONSTRAINT FK_FULFILLMENT_LINE_ORDER_LINE FOREIGN KEY (order_line_id)
          REFERENCES order_line (id) ON DELETE RESTRICT
      ) COLLATE = utf8mb4_unicode_ci;
    `);
    await queryRunner.query(
      'CREATE INDEX IDX_FULFILLMENT_LINE_ORDER_LINE ON fulfillment_line (order_line_id);',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS fulfillment_line;');
    await queryRunner.query('DROP TABLE IF EXISTS fulfillment;');
  }
}
