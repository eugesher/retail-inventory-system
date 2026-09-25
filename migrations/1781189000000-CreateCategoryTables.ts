import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateCategoryTables1781189000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
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
    await queryRunner.query('DROP TABLE product_categories;');
    await queryRunner.query('DROP TABLE category;');
  }
}
