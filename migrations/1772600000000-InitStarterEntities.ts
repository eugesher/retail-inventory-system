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
      CREATE TABLE storage (
        id         VARCHAR(36) PRIMARY KEY,
        name       VARCHAR(100),
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP
      );
    `);

    await queryRunner.query(`
      CREATE TABLE product_stock_action (
        id         VARCHAR(36) PRIMARY KEY,
        name       VARCHAR(100) NOT NULL,
        created_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP
      );
    `);

    await queryRunner.query(`
      CREATE TABLE product_stock (
        id         BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        product_id BIGINT UNSIGNED NOT NULL,
        storage_id VARCHAR(36)     NOT NULL,
        action_id  VARCHAR(36)     NOT NULL,
        quantity   INT             NOT NULL,
        created_at TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT FK_PRODUCT_STOCK_PRODUCT FOREIGN KEY (product_id)
          REFERENCES product (id),
        CONSTRAINT FK_PRODUCT_STOCK_STORAGE FOREIGN KEY (storage_id)
          REFERENCES storage (id),
        CONSTRAINT FK_PRODUCT_STOCK_ACTION FOREIGN KEY (action_id)
          REFERENCES product_stock_action (id)
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
        customer_id BIGINT UNSIGNED NOT NULL,
        status_id   VARCHAR(36)     NOT NULL,
        created_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT FK_ORDER_CUSTOMER FOREIGN KEY (customer_id)
          REFERENCES customer (id)
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
          REFERENCES \`order\` (id),
        CONSTRAINT FK_ORDER_PRODUCT_PRODUCT FOREIGN KEY (order_id)
          REFERENCES \`order\` (id)
      );
    `);

    await queryRunner.query('INSERT INTO storage (id, name) VALUES (?);', [
      ['head-warehouse', 'Head Warehouse'],
    ]);

    await queryRunner.query('INSERT INTO order_status (id, name, color) VALUES ?;', [
      [
        ['pending', 'Pending', '44CCFF'],
        ['confirmed', 'Confirmed', '35FF69'],
      ],
    ]);

    await queryRunner.query('INSERT INTO order_product_status (id, name, color) VALUES ?;', [
      [
        ['pending', 'Pending', '44CCFF'],
        ['confirmed', 'Confirmed', '35FF69'],
      ],
    ]);

    await queryRunner.query('INSERT INTO product_stock_action (id, name) VALUES ?;', [
      [
        ['manual-stock-update', 'Manual Stock Update'],
        ['order-product-confirm', 'Order Product Confirm'],
      ],
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE order_product;');
    await queryRunner.query('DROP TABLE order_product_status;');
    await queryRunner.query('DROP TABLE `order`;');
    await queryRunner.query('DROP TABLE order_status;');
    await queryRunner.query('DROP TABLE customer;');
    await queryRunner.query('DROP TABLE product_stock;');
    await queryRunner.query('DROP TABLE product_stock_action;');
    await queryRunner.query('DROP TABLE storage;');
    await queryRunner.query('DROP TABLE product;');
  }
}
