import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateReservationTable1781309334478 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE reservation (
        id                CHAR(36)        NOT NULL PRIMARY KEY,
        variant_id        BIGINT UNSIGNED NOT NULL,
        stock_location_id VARCHAR(64)     NOT NULL,
        quantity          INT             NOT NULL,
        cart_id           CHAR(36)        NOT NULL COLLATE utf8mb4_unicode_ci,
        expires_at        TIMESTAMP       NOT NULL,
        status            ENUM('active','committed','released','expired') NOT NULL DEFAULT 'active',
        version           INT             NOT NULL DEFAULT 0,
        created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at        TIMESTAMP       NULL,
        CONSTRAINT UC_RESERVATION_CART_VARIANT_LOCATION UNIQUE (cart_id, variant_id, stock_location_id),
        CONSTRAINT FK_RESERVATION_VARIANT FOREIGN KEY (variant_id)
          REFERENCES product_variant (id) ON DELETE RESTRICT,
        CONSTRAINT FK_RESERVATION_LOCATION FOREIGN KEY (stock_location_id)
          REFERENCES stock_location (id) ON DELETE RESTRICT,
        CONSTRAINT FK_RESERVATION_CART FOREIGN KEY (cart_id)
          REFERENCES cart (id) ON DELETE RESTRICT,
        CONSTRAINT CK_RESERVATION_QTY CHECK (quantity > 0)
      );
    `);

    await queryRunner.query('CREATE INDEX IDX_RESERVATION_EXPIRES_AT ON reservation (expires_at);');
    await queryRunner.query(
      'CREATE INDEX IDX_RESERVATION_STATUS_EXPIRES_AT ON reservation (status, expires_at);',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS reservation;');
  }
}
