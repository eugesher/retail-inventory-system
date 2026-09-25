import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropInventoryProductStub1780392162294 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE product_stock DROP FOREIGN KEY FK_PRODUCT_STOCK_PRODUCT;');
    await queryRunner.query('ALTER TABLE order_product DROP FOREIGN KEY FK_ORDER_PRODUCT_PRODUCT;');
    await queryRunner.query('DROP TABLE product;');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE product (
        id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        name       VARCHAR(255) NOT NULL,
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP
      );
    `);
    await queryRunner.query(`
      ALTER TABLE product_stock ADD CONSTRAINT FK_PRODUCT_STOCK_PRODUCT
        FOREIGN KEY (product_id) REFERENCES product (id);
    `);
    await queryRunner.query(`
      ALTER TABLE order_product ADD CONSTRAINT FK_ORDER_PRODUCT_PRODUCT
        FOREIGN KEY (product_id) REFERENCES product (id);
    `);
  }
}
