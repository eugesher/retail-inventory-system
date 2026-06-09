import { MigrationInterface, QueryRunner } from 'typeorm';

// Creates the rebuilt retail checkout's mutable side: the `cart` aggregate root
// and its `cart_line` children. A cart is the shopper's editable working set,
// distinct from the immutable `Order` snapshot it converts into at place-time —
// keeping the two apart means a placed order can never be corrupted by a later
// cart edit (docs/adr/028-cart-order-payment-and-address-chain.md §1).
//
// `cart.id` is a CHAR(36) UUID generated in-app (not the project's auto-increment
// integer PK). Both tables carry `version` / soft-delete affordances that ship
// now though their guards land later: `cart.version` is the optimistic-concurrency
// token (ADR-028 §6, the same forward-provisioning ADR-027 used for
// `stock_level.version`), and `deleted_at` exists because the entities extend
// `BaseEntity` (TypeORM appends `deleted_at IS NULL` to every `find`) — it stays
// INERT, a cart is purged by status, never soft-deleted.
//
// `variant_id` is a real cross-service FK onto the catalog `product_variant(id)`
// (all services share the one MySQL database), the opaque downstream backbone key
// (ADR-025/027); `customer_id` FKs onto the gateway `customer(id)` auth aggregate
// (ADR-024) and is nullable (a guest cart, or a customer deleted out from under a
// cart). The CHAR(36) columns + tables are `utf8mb4_unicode_ci` so the
// `cart_line.cart_id → cart.id` and `cart.customer_id → customer.id` FK collations
// match.
export class CreateCartTables1781041255857 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE cart (
        id          CHAR(36)    NOT NULL PRIMARY KEY,
        customer_id CHAR(36)    NULL,
        currency    CHAR(3)     NOT NULL,
        status      ENUM('active','abandoned','converted') NOT NULL DEFAULT 'active',
        expires_at  TIMESTAMP   NULL,
        version     INT         NOT NULL DEFAULT 0,
        created_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at  TIMESTAMP   NULL,
        CONSTRAINT FK_CART_CUSTOMER FOREIGN KEY (customer_id)
          REFERENCES customer (id) ON DELETE SET NULL
      ) COLLATE = utf8mb4_unicode_ci;
    `);

    // `unit_price_snapshot_minor` is the per-unit price (minor units) captured
    // when the line was added — held stable while sibling lines mutate.
    // `CK_CART_LINE_QTY` backs the positive-quantity invariant at the DB (MySQL
    // 8.4 enforces CHECK, as the stock_level CHECKs rely on).
    await queryRunner.query(`
      CREATE TABLE cart_line (
        id                        BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        cart_id                   CHAR(36)        NOT NULL,
        variant_id                BIGINT UNSIGNED NOT NULL,
        quantity                  INT             NOT NULL,
        unit_price_snapshot_minor BIGINT          NOT NULL,
        currency_snapshot         CHAR(3)         NOT NULL,
        created_at                TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at                TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at                TIMESTAMP       NULL,
        CONSTRAINT FK_CART_LINE_CART FOREIGN KEY (cart_id)
          REFERENCES cart (id) ON DELETE CASCADE,
        CONSTRAINT FK_CART_LINE_VARIANT FOREIGN KEY (variant_id)
          REFERENCES product_variant (id) ON DELETE RESTRICT,
        CONSTRAINT CK_CART_LINE_QTY CHECK (quantity > 0)
      ) COLLATE = utf8mb4_unicode_ci;
    `);
    await queryRunner.query('CREATE INDEX IDX_CART_LINE_CART ON cart_line (cart_id);');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // `cart_line` first — it FKs onto `cart`.
    await queryRunner.query('DROP TABLE IF EXISTS cart_line;');
    await queryRunner.query('DROP TABLE IF EXISTS cart;');
  }
}
