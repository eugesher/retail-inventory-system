import { MigrationInterface, QueryRunner } from 'typeorm';

// Creates the `stock_movement` table: the append-only inventory audit ledger that
// records WHY a counter changed
// (docs/adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md §2). It is
// an AUDIT TRAIL, not the balance authority — ADR-027's `stock_level` running
// totals remain the source of truth, and the sum of movement rows is NOT expected
// to reconstruct on-hand (an `allocation` and its cancelling `release` are both
// negative by the per-type sign rule, so they do not net to zero).
//
// The ledger is APPEND-ONLY: rows are INSERTed and never updated or deleted (the
// domain instance is frozen, the port exposes only `append` + `listByVariant`, and
// the repository uses `insert`). `updated_at` and `deleted_at` exist only because
// the entity extends `BaseEntity`; they are INERT BY CONSTRUCTION — nothing ever
// writes them after the initial INSERT.
//
// `type` is the fixed six-value vocabulary; `quantity` is SIGNED (positive on
// receipt/return, negative on sale/allocation/release, either sign on adjustment —
// the domain enforces the per-type sign). `variant_id` and `stock_location_id` are
// real cross-service FKs (`ON DELETE RESTRICT`) yet stay semantically OPAQUE to the
// inventory domain (no entity import — ADR-027). `reference_type` / `reference_id`
// pair a movement with the business document that caused it (`cart` / `order` /
// `transfer` / `return-request`) and carry NO FK — the reference is POLYMORPHIC
// (the `media_asset.owner_id` precedent, ADR-029); the index + use-case-side
// integrity are the compensation. `actor_id` null = a system action.
//
// COLLATION: the only string FK here is `stock_location_id → stock_location(id)`,
// and `stock_location` sits at the MySQL 8.4 server default (`utf8mb4_0900_ai_ci`).
// So — unlike `payment` — this table takes NO table-level COLLATE override: it
// stays at the server default to match the inventory family it references (the
// `reservation` precedent; `reference_id` is FK-less, so it never hits a collation
// mismatch).
export class CreateStockMovementTable1781338464522 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE stock_movement (
        id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        variant_id        BIGINT UNSIGNED NOT NULL,
        stock_location_id VARCHAR(64)     NOT NULL,
        type              ENUM('receipt','adjustment','allocation','sale','release','return') NOT NULL,
        quantity          INT             NOT NULL,
        reason_code       VARCHAR(64)     NULL,
        reference_type    VARCHAR(32)     NULL,
        reference_id      VARCHAR(64)     NULL,
        actor_id          VARCHAR(64)     NULL,
        occurred_at       TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        -- INERT: the ledger is append-only, so these are never written after INSERT.
        updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at        TIMESTAMP       NULL,
        CONSTRAINT FK_STOCK_MOVEMENT_VARIANT FOREIGN KEY (variant_id)
          REFERENCES product_variant (id) ON DELETE RESTRICT,
        CONSTRAINT FK_STOCK_MOVEMENT_LOCATION FOREIGN KEY (stock_location_id)
          REFERENCES stock_location (id) ON DELETE RESTRICT
      );
    `);

    // The audit read's newest-first per-variant scan: a MySQL 8 DESCENDING index on
    // the trailing column so `(variant_id = ?) ORDER BY occurred_at DESC` is served
    // straight from the index.
    await queryRunner.query(
      'CREATE INDEX IDX_STOCK_MOVEMENT_VARIANT_OCCURRED ON stock_movement (variant_id, occurred_at DESC);',
    );
    // Resolve "what movements did this business document cause?" — the polymorphic
    // reference lookup that compensates for the missing FK.
    await queryRunner.query(
      'CREATE INDEX IDX_STOCK_MOVEMENT_REFERENCE ON stock_movement (reference_type, reference_id);',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS stock_movement;');
  }
}
