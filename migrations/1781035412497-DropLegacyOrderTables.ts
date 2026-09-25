import { MigrationInterface, QueryRunner } from 'typeorm';

export class DropLegacyOrderTables1781035412497 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS order_product;');
    await queryRunner.query('DROP TABLE IF EXISTS order_product_status;');
    await queryRunner.query('DROP TABLE IF EXISTS `order`;');
    await queryRunner.query('DROP TABLE IF EXISTS order_status;');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE order_status (
        id         VARCHAR(36) PRIMARY KEY,
        name       VARCHAR(100) NOT NULL,
        color      CHAR(6)      NOT NULL,
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP
      );
    `);

    await queryRunner.query(`
      CREATE TABLE \`order\` (
        id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        status_id   VARCHAR(36)     NOT NULL,
        created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP
      );
    `);

    await queryRunner.query(`
      CREATE TABLE order_product_status (
        id         VARCHAR(36) PRIMARY KEY,
        name       VARCHAR(100) NOT NULL,
        color      CHAR(6)      NOT NULL,
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP
      );
    `);

    await queryRunner.query(`
      CREATE TABLE order_product (
        id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        product_id BIGINT UNSIGNED NOT NULL,
        order_id   BIGINT UNSIGNED NOT NULL,
        status_id  VARCHAR(36)     NOT NULL,
        created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT FK_ORDER_PRODUCT_ORDER FOREIGN KEY (order_id)
          REFERENCES \`order\` (id)
      );
    `);

    await queryRunner.query(`
      INSERT INTO order_status (id, name, color) VALUES
        ('pending', 'Pending', '44CCFF'),
        ('confirmed', 'Confirmed', '35FF69');
    `);
    await queryRunner.query(`
      INSERT INTO order_product_status (id, name, color) VALUES
        ('pending', 'Pending', '44CCFF'),
        ('confirmed', 'Confirmed', '35FF69');
    `);
  }
}
