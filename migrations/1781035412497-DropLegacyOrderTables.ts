import { MigrationInterface, QueryRunner } from 'typeorm';

// Tears down the legacy retail order model: the `order` / `order_product`
// header+line tables and their `order_status` / `order_product_status`
// reference lookups. The rebuilt checkout model (a mutable `Cart` and an
// immutable `Order` snapshot, with Payment + Address) is a structurally
// different shape, so this is a clean cut rather than an in-place reshape —
// see docs/adr/028-cart-order-payment-and-address-chain.md.
//
// `down` recreates the four tables in the shape they actually had at the start
// of this change, NOT verbatim from InitStarterEntities:
//   - `order` is recreated WITHOUT `customer_id` / `FK_ORDER_CUSTOMER`. An
//     earlier migration (CreateCustomerTable) already dropped that column when
//     it replaced the BIGINT customer with the gateway CHAR(36) aggregate, so
//     restoring it here would not match the schema this migration reverts onto.
//   - `order_product` keeps its `product_id` column but only re-adds
//     `FK_ORDER_PRODUCT_ORDER`. The `product` table (and `FK_ORDER_PRODUCT_PRODUCT`)
//     was dropped by the inventory-product-stub removal, so the product FK
//     cannot be restored.
// The reference-table seed rows are re-inserted so a revert is a faithful
// restore of the pre-drop state.
export class DropLegacyOrderTables1781035412497 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Drop in FK-dependency order: `order_product` references `order`, so it
    // goes first; the two reference lookups have no inbound FKs.
    await queryRunner.query('DROP TABLE IF EXISTS order_product;');
    await queryRunner.query('DROP TABLE IF EXISTS order_product_status;');
    await queryRunner.query('DROP TABLE IF EXISTS `order`;');
    await queryRunner.query('DROP TABLE IF EXISTS order_status;');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Recreate in dependency order: the reference lookups and `order` before
    // `order_product` (which FKs onto `order`).
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

    // Re-seed the two-value status reference rows InitStarterEntities provisioned.
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
