import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitStarterEntities1772600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
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
      CREATE TABLE store (
        id         VARCHAR(36) PRIMARY KEY,
        name       VARCHAR(100),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP
      );
    `);

    await queryRunner.query(`
      CREATE TABLE product_stock (
        id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        product_id BIGINT UNSIGNED NOT NULL,
        store_id   VARCHAR(36)     NOT NULL,
        quantity   INT    UNSIGNED NOT NULL,
        created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT FK_PRODUCT_STOCK_PRODUCT FOREIGN KEY (product_id)
          REFERENCES product (id),
        CONSTRAINT FK_PRODUCT_STOCK_STORE FOREIGN KEY (store_id)
          REFERENCES store (id)
      );
    `);

    await queryRunner.query(`
      CREATE TABLE customer (
        id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        email      VARCHAR(255) NOT NULL,
        first_name VARCHAR(100) NULL,
        last_name  VARCHAR(100) NULL,
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP 
          ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT UC_CUSTOMER_EMAIL UNIQUE (email)
      );
    `);

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
        total       INT UNSIGNED    NOT NULL,
        statusId    VARCHAR(36)     NOT NULL,
        customer_id BIGINT UNSIGNED NOT NULL,
        created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP
      );
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE `order`;');
    await queryRunner.query('DROP TABLE order_status;');
    await queryRunner.query('DROP TABLE customer;');
    await queryRunner.query('DROP TABLE product_stock;');
    await queryRunner.query('DROP TABLE store;');
    await queryRunner.query('DROP TABLE product;');
  }
}
