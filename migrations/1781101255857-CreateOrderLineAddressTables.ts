import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreateOrderLineAddressTables1781101255857 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE address (
        id             CHAR(36)     NOT NULL PRIMARY KEY,
        owner_type     ENUM('customer','order') NOT NULL,
        owner_id       VARCHAR(36)  NOT NULL,
        recipient_name VARCHAR(255) NOT NULL,
        line1          VARCHAR(255) NOT NULL,
        line2          VARCHAR(255) NULL,
        city           VARCHAR(128) NOT NULL,
        region         VARCHAR(128) NOT NULL,
        postal_code    VARCHAR(32)  NOT NULL,
        country        CHAR(2)      NOT NULL,
        phone          VARCHAR(32)  NULL,
        created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at     TIMESTAMP    NULL
      ) COLLATE = utf8mb4_unicode_ci;
    `);
    await queryRunner.query('CREATE INDEX IDX_ADDRESS_OWNER ON address (owner_type, owner_id);');

    await queryRunner.query(`
      CREATE TABLE \`order\` (
        id                   BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        order_number         VARCHAR(20)  NOT NULL,
        customer_id          CHAR(36)     NULL,
        currency             CHAR(3)      NOT NULL,
        status               ENUM('pending','confirmed','cancelled','shipped','delivered') NOT NULL DEFAULT 'pending',
        payment_status       ENUM('none','authorized','captured','refunded','failed')      NOT NULL DEFAULT 'none',
        fulfillment_status   ENUM('unfulfilled','partially-shipped','shipped','delivered') NOT NULL DEFAULT 'unfulfilled',
        subtotal_minor       BIGINT NOT NULL,
        tax_total_minor      BIGINT NOT NULL DEFAULT 0,
        discount_total_minor BIGINT NOT NULL DEFAULT 0,
        shipping_total_minor BIGINT NOT NULL DEFAULT 0,
        grand_total_minor    BIGINT NOT NULL,
        billing_address_id   CHAR(36)  NULL,
        shipping_address_id  CHAR(36)  NULL,
        source_cart_id       CHAR(36)  NULL,
        placed_at            TIMESTAMP NULL,
        version              INT       NOT NULL DEFAULT 0,
        created_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at           TIMESTAMP NULL,
        CONSTRAINT UC_ORDER_NUMBER UNIQUE (order_number),
        CONSTRAINT FK_ORDER_CUSTOMER FOREIGN KEY (customer_id)
          REFERENCES customer (id) ON DELETE SET NULL,
        CONSTRAINT FK_ORDER_BILLING_ADDRESS  FOREIGN KEY (billing_address_id)  REFERENCES address (id),
        CONSTRAINT FK_ORDER_SHIPPING_ADDRESS FOREIGN KEY (shipping_address_id) REFERENCES address (id),
        CONSTRAINT FK_ORDER_SOURCE_CART FOREIGN KEY (source_cart_id) REFERENCES cart (id) ON DELETE SET NULL
      ) COLLATE = utf8mb4_unicode_ci;
    `);
    await queryRunner.query(
      'CREATE INDEX IDX_ORDER_CUSTOMER_PLACED ON `order` (customer_id, placed_at);',
    );

    await queryRunner.query(`
      CREATE TABLE order_line (
        id                    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        order_id              BIGINT UNSIGNED NOT NULL,
        variant_id            BIGINT UNSIGNED NOT NULL,
        sku                   VARCHAR(64)  NOT NULL,
        name_snapshot         VARCHAR(255) NOT NULL,
        quantity              INT          NOT NULL,
        unit_price_minor      BIGINT       NOT NULL,
        tax_amount_minor      BIGINT       NOT NULL DEFAULT 0,
        discount_amount_minor BIGINT       NOT NULL DEFAULT 0,
        line_total_minor      BIGINT       NOT NULL,
        status                ENUM('allocated','shipped','partially-shipped','cancelled','returned') NOT NULL DEFAULT 'allocated',
        created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at            TIMESTAMP NULL,
        CONSTRAINT FK_ORDER_LINE_ORDER FOREIGN KEY (order_id)
          REFERENCES \`order\` (id) ON DELETE RESTRICT,
        CONSTRAINT FK_ORDER_LINE_VARIANT FOREIGN KEY (variant_id)
          REFERENCES product_variant (id) ON DELETE RESTRICT
      ) COLLATE = utf8mb4_unicode_ci;
    `);
    await queryRunner.query('CREATE INDEX IDX_ORDER_LINE_ORDER ON order_line (order_id);');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS order_line;');
    await queryRunner.query('DROP TABLE IF EXISTS `order`;');
    await queryRunner.query('DROP TABLE IF EXISTS address;');
  }
}
