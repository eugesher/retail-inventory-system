import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCatalogTables1780409695171 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE product (
        id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        slug        VARCHAR(255) NOT NULL,
        description TEXT NULL,
        status      ENUM('draft','active','archived') NOT NULL DEFAULT 'draft',
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at  TIMESTAMP NULL,
        CONSTRAINT UC_PRODUCT_SLUG UNIQUE (slug)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE product_variant (
        id            BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        product_id    BIGINT UNSIGNED NOT NULL,
        sku           VARCHAR(255) NOT NULL,
        gtin          VARCHAR(64) NULL,
        option_values JSON NOT NULL,
        weight_g      INT NULL,
        dimensions_mm JSON NULL,
        status        ENUM('active','archived') NOT NULL DEFAULT 'active',
        created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at    TIMESTAMP NULL,
        CONSTRAINT UC_PRODUCT_VARIANT_SKU UNIQUE (sku),
        CONSTRAINT UC_PRODUCT_VARIANT_GTIN UNIQUE (gtin),
        CONSTRAINT FK_PRODUCT_VARIANT_PRODUCT FOREIGN KEY (product_id)
          REFERENCES product (id) ON DELETE RESTRICT
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE product_variant;');
    await queryRunner.query('DROP TABLE product;');
  }
}
