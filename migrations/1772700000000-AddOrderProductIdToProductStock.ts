import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddOrderProductIdToProductStock1772700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE product_stock
        ADD COLUMN order_product_id BIGINT UNSIGNED NULL AFTER quantity,
        ADD CONSTRAINT FK_PRODUCT_STOCK_ORDER_PRODUCT FOREIGN KEY (order_product_id)
          REFERENCES order_product (id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE product_stock
        DROP FOREIGN KEY FK_PRODUCT_STOCK_ORDER_PRODUCT,
        DROP COLUMN order_product_id;
    `);
  }
}
