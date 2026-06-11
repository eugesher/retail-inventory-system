import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCategoryTables1781260000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // `id` is BIGINT UNSIGNED AUTO_INCREMENT to match the project convention for
    // catalog tables (see CreateCatalogTables). The entities extend `BaseEntity`,
    // whose `@PrimaryGeneratedColumn()` only carries `int` in TypeORM metadata —
    // `synchronize` is off, so the wider DB type is the source of truth. A
    // narrower INT here would also force a type mismatch against the
    // `product_categories.category_id` sibling FK below.
    //
    // `path` is the MATERIALIZED PATH (`/electronics/phones`): the full
    // root-to-self slug chain, indexed so a subtree read is a single
    // `path LIKE '/electronics/phones%'` rather than a recursive walk (ADR-029).
    //
    // The self-FK is `ON DELETE SET NULL` as a SCHEMA-LEVEL SAFETY NET ONLY — no
    // hard-delete operation exists (archival is via the `status` column). If a
    // row were ever deleted by hand, its children demote to root (`parent_id`
    // nulled) rather than block the delete or cascade it. `deleted_at` is
    // inherited from `BaseEntity` but stays NULL forever (status-driven
    // soft-delete, ADR-025).
    await queryRunner.query(`
      CREATE TABLE category (
        id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name       VARCHAR(255) NOT NULL,
        slug       VARCHAR(255) NOT NULL,
        parent_id  BIGINT UNSIGNED NULL,
        path       VARCHAR(512) NOT NULL,
        sort_order INT NOT NULL DEFAULT 0,
        status     ENUM('active','archived') NOT NULL DEFAULT 'active',
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at TIMESTAMP NULL,
        CONSTRAINT UC_CATEGORY_SLUG UNIQUE (slug),
        CONSTRAINT FK_CATEGORY_PARENT FOREIGN KEY (parent_id)
          REFERENCES category (id) ON DELETE SET NULL
      );
    `);

    await queryRunner.query('CREATE INDEX IDX_CATEGORY_PARENT ON category (parent_id);');
    await queryRunner.query('CREATE INDEX IDX_CATEGORY_PATH ON category (path);');

    // `product_categories` is a BARE N↔M join (composite PK, no surrogate id, no
    // timestamps) and intentionally gets NO TypeORM entity — the repository
    // maintains it with parameterized SQL through the injected manager (the
    // `product_variant.tax_category_id` precedent). Both FKs are ON DELETE
    // CASCADE: a membership row is meaningless once either side is hard-deleted.
    // The membership read/write methods land with the reclassify capability.
    await queryRunner.query(`
      CREATE TABLE product_categories (
        product_id  BIGINT UNSIGNED NOT NULL,
        category_id BIGINT UNSIGNED NOT NULL,
        PRIMARY KEY (product_id, category_id),
        CONSTRAINT FK_PRODUCT_CATEGORIES_PRODUCT FOREIGN KEY (product_id)
          REFERENCES product (id) ON DELETE CASCADE,
        CONSTRAINT FK_PRODUCT_CATEGORIES_CATEGORY FOREIGN KEY (category_id)
          REFERENCES category (id) ON DELETE CASCADE
      );
    `);

    await queryRunner.query(
      'CREATE INDEX IDX_PRODUCT_CATEGORIES_CATEGORY ON product_categories (category_id);',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Join table first — its FK references `category`, and `category`'s self-FK
    // is dropped with the table. Order is join → category.
    await queryRunner.query('DROP TABLE product_categories;');
    await queryRunner.query('DROP TABLE category;');
  }
}
