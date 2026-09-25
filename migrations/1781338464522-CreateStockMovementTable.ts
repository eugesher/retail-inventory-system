import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateStockMovementTable1781338464522 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE stock_movement (
        id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        variant_id        BIGINT UNSIGNED NOT NULL,
        stock_location_id VARCHAR(64)     NOT NULL,
        type              ENUM('receipt','adjustment','allocation','sale','release','return') NOT NULL,
        quantity          INT             NOT NULL,
        reason_code       VARCHAR(64)     NULL,
        reference_type    VARCHAR(32)     NULL,
        reference_id      VARCHAR(64)     NULL,
        actor_id          VARCHAR(64)     NULL,
        occurred_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at        TIMESTAMP       NULL,
        CONSTRAINT FK_STOCK_MOVEMENT_VARIANT FOREIGN KEY (variant_id)
          REFERENCES product_variant (id) ON DELETE RESTRICT,
        CONSTRAINT FK_STOCK_MOVEMENT_LOCATION FOREIGN KEY (stock_location_id)
          REFERENCES stock_location (id) ON DELETE RESTRICT
      );
    `);

    await queryRunner.query(
      'CREATE INDEX IDX_STOCK_MOVEMENT_VARIANT_OCCURRED ON stock_movement (variant_id, occurred_at DESC);',
    );
    await queryRunner.query(
      'CREATE INDEX IDX_STOCK_MOVEMENT_REFERENCE ON stock_movement (reference_type, reference_id);',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS stock_movement;');
  }
}
