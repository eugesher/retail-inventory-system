import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCatalogTables1780409695171 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // `id` is BIGINT UNSIGNED AUTO_INCREMENT to match the project convention
    // (see InitStarterEntities). The entities extend `BaseEntity`, whose
    // `@PrimaryGeneratedColumn()` only carries `int` in TypeORM metadata —
    // `synchronize` is off, so the wider DB type is the source of truth.
    //
    // `deleted_at` is present because `BaseEntity` declares a
    // `@DeleteDateColumn`; TypeORM appends `deleted_at IS NULL` to every
    // `find`. Catalog soft-deletes via the `status` column and never calls
    // `softRemove`, so `deleted_at` stays NULL forever (ADR-025).
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

    // GTIN is nullable + UNIQUE: MySQL allows multiple NULLs under a UNIQUE
    // index, so the constraint behaves as a nullable-aware ("partial") unique
    // with no extra work. The FK is ON DELETE RESTRICT — a product with
    // variants cannot be hard-deleted; archival via `status` is the path.
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
    // Child first — the FK forbids dropping `product` while `product_variant`
    // still references it.
    await queryRunner.query('DROP TABLE product_variant;');
    await queryRunner.query('DROP TABLE product;');
  }
}
