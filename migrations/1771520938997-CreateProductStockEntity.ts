import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateProductStockEntity1771520938997 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS product_stock (
        productId VARCHAR(16) NOT NULL,
        storeId   VARCHAR(32) NOT NULL,
        quantity  INT         NOT NULL DEFAULT 0,
        updatedAt TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP
        ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (productId, storeId),
        INDEX IDX_ProductStockStoreId (storeId)
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE product_stock;');
  }
}
