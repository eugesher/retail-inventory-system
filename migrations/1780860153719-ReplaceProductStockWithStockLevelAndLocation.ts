import { MigrationInterface, QueryRunner } from 'typeorm';

// Replaces the append-only `product_stock` ledger (+ its `product_stock_action`
// lookup and the `storage` table) with per-location `StockLevel` running totals
// (`stock_level`) anchored on location-aware `stock_location` rows. All keys
// move from `productId` to `variantId` — `stock_level.variant_id` is a real
// cross-service FK to the catalog `product_variant(id)` (both tables share the
// one MySQL connection). See docs/adr/027-stocklevel-running-totals-and-stocklocation.md.
export class ReplaceProductStockWithStockLevelAndLocation1780860153719 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // `product_stock` first — it carries the FKs onto `storage` /
    // `product_stock_action`; dropping it releases them so the lookups drop
    // cleanly. (`product` was already dropped by an earlier migration.)
    await queryRunner.query('DROP TABLE IF EXISTS product_stock;');
    await queryRunner.query('DROP TABLE IF EXISTS product_stock_action;');
    await queryRunner.query('DROP TABLE IF EXISTS storage;');

    // `id` is a caller-assigned VARCHAR(64) string PK (`default-warehouse`),
    // diverging from the project's auto-increment integer PK convention.
    // `deleted_at` is present because the entity extends `BaseEntity`; it stays
    // INERT — soft-delete is via the `active` flag (ADR-027).
    await queryRunner.query(`
      CREATE TABLE stock_location (
        id          VARCHAR(64)  NOT NULL PRIMARY KEY,
        name        VARCHAR(255) NOT NULL,
        code        VARCHAR(64)  NOT NULL,
        type        ENUM('warehouse','store','dropship-virtual') NOT NULL DEFAULT 'warehouse',
        address     JSON NULL,
        gln         VARCHAR(13) NULL,
        active      BOOLEAN NOT NULL DEFAULT TRUE,
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at  TIMESTAMP NULL,
        CONSTRAINT UC_STOCK_LOCATION_CODE UNIQUE (code)
      );
    `);

    // `version` ships now (optimistic-concurrency token) though the no-oversell
    // invariant it guards is enforced by a later capability — shipping the
    // column from the start makes that retrofit non-destructive. The three
    // `CHECK` constraints back the non-negative-quantity invariants at the DB
    // (MySQL 8.4 enforces CHECK). `id` widens the entity's int PK to BIGINT
    // (`synchronize` is off, so the migration is the source of truth).
    await queryRunner.query(`
      CREATE TABLE stock_level (
        id                 BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        variant_id         BIGINT UNSIGNED NOT NULL,
        stock_location_id  VARCHAR(64) NOT NULL,
        quantity_on_hand   INT NOT NULL DEFAULT 0,
        quantity_allocated INT NOT NULL DEFAULT 0,
        quantity_reserved  INT NOT NULL DEFAULT 0,
        version            INT NOT NULL DEFAULT 0,
        created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at         TIMESTAMP NULL,
        CONSTRAINT UC_STOCK_LEVEL_VARIANT_LOCATION UNIQUE (variant_id, stock_location_id),
        CONSTRAINT FK_STOCK_LEVEL_LOCATION FOREIGN KEY (stock_location_id)
          REFERENCES stock_location (id) ON DELETE RESTRICT,
        CONSTRAINT FK_STOCK_LEVEL_VARIANT FOREIGN KEY (variant_id)
          REFERENCES product_variant (id) ON DELETE RESTRICT,
        CONSTRAINT CK_STOCK_LEVEL_ON_HAND   CHECK (quantity_on_hand   >= 0),
        CONSTRAINT CK_STOCK_LEVEL_ALLOCATED CHECK (quantity_allocated >= 0),
        CONSTRAINT CK_STOCK_LEVEL_RESERVED  CHECK (quantity_reserved  >= 0)
      );
    `);
    await queryRunner.query(
      'CREATE INDEX IDX_STOCK_LEVEL_LOCATION ON stock_level (stock_location_id);',
    );

    // Exactly one default StockLocation, idempotently provisioned: a re-run hits
    // the PK (and the UNIQUE code) and no-ops rather than erroring (ADR-027).
    await queryRunner.query(`
      INSERT INTO stock_location (id, name, code, type, active)
      VALUES ('default-warehouse', 'Default Warehouse', 'default-warehouse', 'warehouse', TRUE)
      ON DUPLICATE KEY UPDATE id = id;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse in dependency order: `stock_level` (FKs onto `stock_location` +
    // `product_variant`) before `stock_location`.
    await queryRunner.query('DROP TABLE IF EXISTS stock_level;');
    await queryRunner.query('DROP TABLE IF EXISTS stock_location;');

    // Recreate the prior ledger shape so a revert returns the schema to its
    // earlier state cleanly. `storage` + `product_stock_action` first (the
    // `product_stock` FKs target them). `product_stock` has NO `product` FK —
    // that was dropped by the inventory-product-stub removal — but keeps the
    // `order_product_id` FK added afterwards.
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
        id               BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        product_id       BIGINT UNSIGNED NOT NULL,
        storage_id       VARCHAR(36)     NOT NULL,
        action_id        VARCHAR(36)     NOT NULL,
        quantity         INT             NOT NULL,
        order_product_id BIGINT UNSIGNED NULL,
        created_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT FK_PRODUCT_STOCK_STORAGE FOREIGN KEY (storage_id)
          REFERENCES storage (id),
        CONSTRAINT FK_PRODUCT_STOCK_ACTION FOREIGN KEY (action_id)
          REFERENCES product_stock_action (id),
        CONSTRAINT FK_PRODUCT_STOCK_ORDER_PRODUCT FOREIGN KEY (order_product_id)
          REFERENCES order_product (id)
      );
    `);

    // Re-seed the rows InitStarterEntities provisioned alongside these tables so
    // the revert is a faithful restore of the prior state.
    await queryRunner.query(`
      INSERT INTO storage (id, name) VALUES ('head-warehouse', 'Head Warehouse');
    `);
    await queryRunner.query(`
      INSERT INTO product_stock_action (id, name) VALUES
        ('manual-stock-update', 'Manual Stock Update'),
        ('order-product-confirm', 'Order Product Confirm');
    `);
  }
}
