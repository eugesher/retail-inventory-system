import { MigrationInterface, QueryRunner } from 'typeorm';

export class ReplaceProductStockWithStockLevelAndLocation1780860153719 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS product_stock;');
    await queryRunner.query('DROP TABLE IF EXISTS product_stock_action;');
    await queryRunner.query('DROP TABLE IF EXISTS storage;');

    await queryRunner.query(`
      CREATE TABLE stock_location (
        id          VARCHAR(64)  NOT NULL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        code        VARCHAR(64)  NOT NULL,
        type        ENUM('warehouse','store','dropship-virtual') NOT NULL DEFAULT 'warehouse',
        address     JSON NULL,
        gln         VARCHAR(13) NULL,
        active      BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at  TIMESTAMP NULL,
        CONSTRAINT UC_STOCK_LOCATION_CODE UNIQUE (code)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE stock_level (
        id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        variant_id         BIGINT UNSIGNED NOT NULL,
        stock_location_id  VARCHAR(64) NOT NULL,
        quantity_on_hand   INT NOT NULL DEFAULT 0,
        quantity_allocated INT NOT NULL DEFAULT 0,
        quantity_reserved  INT NOT NULL DEFAULT 0,
        version            INT NOT NULL DEFAULT 0,
        created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at         TIMESTAMP NULL,
        CONSTRAINT UC_STOCK_LEVEL_VARIANT_LOCATION UNIQUE (variant_id, stock_location_id),
        CONSTRAINT FK_STOCK_LEVEL_LOCATION FOREIGN KEY (stock_location_id)
          REFERENCES stock_location (id) ON DELETE RESTRICT,
        CONSTRAINT FK_STOCK_LEVEL_VARIANT FOREIGN KEY (variant_id)
          REFERENCES product_variant (id) ON DELETE RESTRICT,
        CONSTRAINT CK_STOCK_LEVEL_ON_HAND   CHECK (quantity_on_hand   >= 0),
        CONSTRAINT CK_STOCK_LEVEL_ALLOCATED CHECK (quantity_allocated >= 0),
        CONSTRAINT CK_STOCK_LEVEL_RESERVED  CHECK (quantity_reserved  >= 0)
      );
    `);
    await queryRunner.query(
      'CREATE INDEX IDX_STOCK_LEVEL_LOCATION ON stock_level (stock_location_id);',
    );

    await queryRunner.query(`
      INSERT INTO stock_location (id, name, code, type, active)
      VALUES ('default-warehouse', 'Default Warehouse', 'default-warehouse', 'warehouse', TRUE)
      ON DUPLICATE KEY UPDATE id = id;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS stock_level;');
    await queryRunner.query('DROP TABLE IF EXISTS stock_location;');

    await queryRunner.query(`
      CREATE TABLE storage (
        id         VARCHAR(36) PRIMARY KEY,
        name       VARCHAR(100),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP
      );
    `);
    await queryRunner.query(`
      CREATE TABLE product_stock_action (
        id         VARCHAR(36) PRIMARY KEY,
        name       VARCHAR(100) NOT NULL,
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP
      );
    `);
    await queryRunner.query(`
      CREATE TABLE product_stock (
        id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        product_id       BIGINT UNSIGNED NOT NULL,
        storage_id       VARCHAR(36)     NOT NULL,
        action_id        VARCHAR(36)     NOT NULL,
        quantity         INT             NOT NULL,
        order_product_id BIGINT UNSIGNED NULL,
        created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT FK_PRODUCT_STOCK_STORAGE FOREIGN KEY (storage_id)
          REFERENCES storage (id),
        CONSTRAINT FK_PRODUCT_STOCK_ACTION FOREIGN KEY (action_id)
          REFERENCES product_stock_action (id),
        CONSTRAINT FK_PRODUCT_STOCK_ORDER_PRODUCT FOREIGN KEY (order_product_id)
          REFERENCES order_product (id)
      );
    `);

    await queryRunner.query(`
      INSERT INTO storage (id, name) VALUES ('head-warehouse', 'Head Warehouse');
    `);
    await queryRunner.query(`
      INSERT INTO product_stock_action (id, name) VALUES
        ('manual-stock-update', 'Manual Stock Update'),
        ('order-product-confirm', 'Order Product Confirm');
    `);
  }
}
