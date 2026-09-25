import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePricingTables1780546069117 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE tax_category (
        id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        code        VARCHAR(50)  NOT NULL,
        name        VARCHAR(255) NOT NULL,
        description VARCHAR(1000) NULL,
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at  TIMESTAMP NULL,
        CONSTRAINT UC_TAX_CATEGORY_CODE UNIQUE (code)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE price (
        id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        variant_id     BIGINT UNSIGNED NOT NULL,
        currency       CHAR(3) NOT NULL,
        amount_minor   BIGINT NOT NULL,
        valid_from     TIMESTAMP NOT NULL,
        valid_to       TIMESTAMP NULL,
        priority       INT NOT NULL DEFAULT 0,
        open_scope_key VARCHAR(32) GENERATED ALWAYS AS
                         (CASE WHEN valid_to IS NULL THEN CONCAT(variant_id, ':', currency) ELSE NULL END) STORED,
        created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at     TIMESTAMP NULL,
        CONSTRAINT UC_PRICE_OPEN_SCOPE UNIQUE (open_scope_key),
        CONSTRAINT FK_PRICE_VARIANT FOREIGN KEY (variant_id)
          REFERENCES product_variant (id) ON DELETE RESTRICT
      );
    `);

    await queryRunner.query(`
      CREATE INDEX IDX_PRICE_RESOLVE ON price (variant_id, currency, valid_from DESC);
    `);

    await queryRunner.query(`
      ALTER TABLE product_variant
        ADD COLUMN tax_category_id INT UNSIGNED NULL,
        ADD CONSTRAINT FK_PRODUCT_VARIANT_TAX_CATEGORY FOREIGN KEY (tax_category_id)
          REFERENCES tax_category (id) ON DELETE SET NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE product_variant DROP FOREIGN KEY FK_PRODUCT_VARIANT_TAX_CATEGORY;',
    );
    await queryRunner.query('ALTER TABLE product_variant DROP COLUMN tax_category_id;');
    await queryRunner.query('DROP TABLE price;');
    await queryRunner.query('DROP TABLE tax_category;');
  }
}
