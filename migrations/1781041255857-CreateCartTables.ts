import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCartTables1781041255857 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE cart (
        id          CHAR(36)    NOT NULL PRIMARY KEY,
        customer_id CHAR(36)    NULL,
        currency    CHAR(3)     NOT NULL,
        status      ENUM('active','abandoned','converted') NOT NULL DEFAULT 'active',
        expires_at  TIMESTAMP   NULL,
        version     INT         NOT NULL DEFAULT 0,
        created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at  TIMESTAMP   NULL,
        CONSTRAINT FK_CART_CUSTOMER FOREIGN KEY (customer_id)
          REFERENCES customer (id) ON DELETE SET NULL
      ) COLLATE = utf8mb4_unicode_ci;
    `);

    await queryRunner.query(`
      CREATE TABLE cart_line (
        id                        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        cart_id                   CHAR(36)        NOT NULL,
        variant_id                BIGINT UNSIGNED NOT NULL,
        quantity                  INT             NOT NULL,
        unit_price_snapshot_minor BIGINT          NOT NULL,
        currency_snapshot         CHAR(3)         NOT NULL,
        created_at                TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at                TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at                TIMESTAMP       NULL,
        CONSTRAINT FK_CART_LINE_CART FOREIGN KEY (cart_id)
          REFERENCES cart (id) ON DELETE CASCADE,
        CONSTRAINT FK_CART_LINE_VARIANT FOREIGN KEY (variant_id)
          REFERENCES product_variant (id) ON DELETE RESTRICT,
        CONSTRAINT CK_CART_LINE_QTY CHECK (quantity > 0)
      ) COLLATE = utf8mb4_unicode_ci;
    `);
    await queryRunner.query('CREATE INDEX IDX_CART_LINE_CART ON cart_line (cart_id);');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS cart_line;');
    await queryRunner.query('DROP TABLE IF EXISTS cart;');
  }
}
