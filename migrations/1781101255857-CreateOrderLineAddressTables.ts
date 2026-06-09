import { MigrationInterface, QueryRunner } from 'typeorm';

// Creates the rebuilt retail checkout's immutable side: the polymorphic `address`
// aggregate, the `order` aggregate root, and its `order_line` children. An order is
// the placed record of what was bought and at what price — distinct from the
// mutable `cart` it converts from, so a placed order can never be corrupted by a
// later cart edit (docs/adr/028-cart-order-payment-and-address-chain.md §1).
//
// Tables are created in FK-dependency order — `address` first (the order references
// it), then `order`, then `order_line`. `order` is a reserved word, backticked
// throughout.
//
// The order carries **three orthogonal status ENUM columns** (`status`,
// `payment_status`, `fulfillment_status`) that evolve independently (ADR-028 §2),
// five BIGINT money totals in minor units, a `version` optimistic-concurrency token
// (ADR-028 §6, the same forward-provisioning ADR-027 used for
// `stock_level.version`), and a UNIQUE `order_number` that backs the human-facing
// id derived in the repository. `customer_id` FKs the gateway `customer(id)` auth
// aggregate (ADR-024) and is **nullable** (`ON DELETE SET NULL`) so deleting a
// customer leaves an order tombstone; `source_cart_id` FKs `cart(id)` (the
// repeat-place idempotency link, `ON DELETE SET NULL`); `order_line.variant_id` is a
// real cross-service FK onto the catalog `product_variant(id)`, the opaque
// downstream backbone key (ADR-025/027). `deleted_at` exists on all three tables
// because the entities extend `BaseEntity` (TypeORM appends `deleted_at IS NULL` to
// every `find`) — it stays INERT, an order/address is append-only/immutable, never
// soft-deleted.
//
// The CHAR(36)/VARCHAR FK columns + tables are `utf8mb4_unicode_ci` so the
// `order.customer_id → customer.id`, `order.billing/shipping_address_id →
// address.id`, and `order.source_cart_id → cart.id` FK collations match the
// referenced columns.
export class CreateOrderLineAddressTables1781101255857 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Polymorphic over (owner_type, owner_id): an address belongs to a `customer`
    // (a future address-book entry) or an `order` (a place-time snapshot). This
    // chain writes only `order` rows. `owner_id` is VARCHAR(36) so it holds either a
    // customer's CHAR(36) UUID or an order's (short, stringified) numeric id.
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

    // `order_line.order_id → order.id` is `ON DELETE RESTRICT` (orders are
    // append-only — a line is never orphaned). `variant_id` is the opaque catalog
    // backbone FK (`ON DELETE RESTRICT`). Every other column is a place-time
    // snapshot; `line_total_minor = unit_price_minor × quantity + tax − discount`.
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
    // Drop in reverse FK order: `order_line` (FKs `order`), then `order` (FKs
    // `address` / `cart` / `customer`), then `address`.
    await queryRunner.query('DROP TABLE IF EXISTS order_line;');
    await queryRunner.query('DROP TABLE IF EXISTS `order`;');
    await queryRunner.query('DROP TABLE IF EXISTS address;');
  }
}
