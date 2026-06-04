import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePricingTables1780546069117 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // A static classification label. `id` is INT UNSIGNED to match the entity's
    // `@PrimaryGeneratedColumn()` (int metadata); `deleted_at` is inherited from
    // `BaseEntity` but stays NULL forever — a tax category is never soft-deleted
    // (ADR-026). `UC_TAX_CATEGORY_CODE` is the hard guard behind the use-case
    // pre-check for global `code` uniqueness.
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

    // One row of the append-only price ledger. `id` is BIGINT UNSIGNED to match
    // the project convention (the entity carries int metadata — `synchronize` is
    // off, so the wider DB type is the source of truth). `variant_id` is BIGINT
    // UNSIGNED to match `product_variant.id`; the FK is ON DELETE RESTRICT so a
    // priced variant cannot be hard-deleted.
    //
    // `open_scope_key` is a STORED generated column that is non-NULL only while
    // `valid_to IS NULL`. MySQL has no native partial unique index, so this
    // emulates "at most one open row per (variant_id, currency)": MySQL permits
    // many NULLs under a UNIQUE index, so closed rows (NULL key) never collide,
    // while two open rows for the same scope produce the same key and the second
    // insert fails. It is the DB-level backstop behind the app-level
    // close-in-transaction primary mechanism (ADR-026).
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

    // The covering index for the Select Applicable candidate query
    // (`findInEffect`): scope by (variant_id, currency), then walk valid_from
    // newest-first.
    await queryRunner.query(`
      CREATE INDEX IDX_PRICE_RESOLVE ON price (variant_id, currency, valid_from DESC);
    `);

    // A variant points at one tax category. The column is NULLABLE (a variant
    // may be unclassified) and the FK is ON DELETE SET NULL so removing a tax
    // category orphans its variants to "unclassified" rather than blocking the
    // delete. The attach use case + endpoint land later; the column exists now.
    await queryRunner.query(`
      ALTER TABLE product_variant
        ADD COLUMN tax_category_id INT UNSIGNED NULL,
        ADD CONSTRAINT FK_PRODUCT_VARIANT_TAX_CATEGORY FOREIGN KEY (tax_category_id)
          REFERENCES tax_category (id) ON DELETE SET NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse in dependency order: drop the product_variant FK + column first
    // (it references tax_category), then price (it references product_variant),
    // then the two tables.
    await queryRunner.query(
      'ALTER TABLE product_variant DROP FOREIGN KEY FK_PRODUCT_VARIANT_TAX_CATEGORY;',
    );
    await queryRunner.query('ALTER TABLE product_variant DROP COLUMN tax_category_id;');
    await queryRunner.query('DROP TABLE price;');
    await queryRunner.query('DROP TABLE tax_category;');
  }
}
