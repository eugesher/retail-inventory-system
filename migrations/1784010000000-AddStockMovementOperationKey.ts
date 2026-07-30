import { MigrationInterface, QueryRunner } from 'typeorm';

// Extends the ledger dedupe UNIQUE to cover Cancel-Allocation, the one post-commit
// cross-service call that had no way into it (ADR-057).
//
// `UC_STOCK_MOVEMENT_DEDUPE` (migration `1783872387242`) closed the concurrent-redelivery
// hole for Commit Sale and Restock From Return by keying on the thing each operation is
// *about* — a `fulfillmentId`, a `returnRequestId`. Cancel-Allocation has no such thing.
// Cancel Line cancels a **quantity**, and ADR-040 made partial cancellation a first-class
// operation, so the same `(order, variant, location)` can legitimately be released twice on
// two different days. Keying on `reference_id` (the order) would therefore reject the second
// **legitimate** partial cancellation as a replay — strictly worse than the race it closed.
//
// So the identity comes from the caller instead: retail mints an `operation_key` once per
// logical cancellation, before its retry loop, and every retry and broker redelivery of that
// operation carries the same value. `operation_key` is the column that stores it.
//
// **What was actually wrong before this.** `StockLevel.releaseAllocated` guards by QUANTITY —
// it refuses to drive `quantity_allocated` below zero and nothing more. On a counter several
// orders share, "there is still enough to subtract" does not mean "this subtraction has not
// happened yet". A redelivered cancel for order A, arriving after order B allocated the same
// variant at the same location, passes that guard and releases **B's** units. The result is an
// understated `quantity_allocated`, an overstated `available`, and an oversell — silent,
// because the running totals are the balance authority and nothing reconciles them against
// the ledger (ADR-027 / ADR-030 §2).
//
// The generated column gains a second arm rather than a wider scope, and the difference
// matters: `type = 'release'` alone would sweep in the OTHER two release producers —
// `ReleaseReservationUseCase` and `SweepExpiredReservationsUseCase` — which write release
// rows with no operation key and must stay unconstrained. `operation_key IS NOT NULL` is what
// keeps them out; a NULL key yields a NULL dedupe key, and MySQL permits many NULLs under a
// UNIQUE (the `price.open_scope_key` technique, ADR-026, this being its fourth application).
//
// `variant_id` + `stock_location_id` ride the key for exactly the reason the first migration
// spells out: one cancellation writes one release row PER LINE, all sharing the one operation
// key, so a key without them would reject every multi-line cancel — trading a rare race for a
// certain outage.
//
// A STORED generated column's expression cannot be edited in place while an index depends on
// it, so the sequence is: add the source column, drop the index, drop the generated column,
// re-add it with the new expression, re-add the index. No data is rewritten — every existing
// row's key recomputes to what it already was, since `operation_key` is NULL for all of them.
//
// Width of the new arm: `'release'`(7) + `operation_key`(64) + `variant_id`(20 digits) +
// `stock_location_id`(64) + 3 separators = 158, inside the existing VARCHAR(200).
export class AddStockMovementOperationKey1784010000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE stock_movement ADD COLUMN operation_key VARCHAR(64) NULL;',
    );
    await queryRunner.query('ALTER TABLE stock_movement DROP INDEX UC_STOCK_MOVEMENT_DEDUPE;');
    await queryRunner.query('ALTER TABLE stock_movement DROP COLUMN movement_dedupe_key;');
    await queryRunner.query(`
      ALTER TABLE stock_movement
        ADD COLUMN movement_dedupe_key VARCHAR(200)
          GENERATED ALWAYS AS (
            CASE WHEN type IN ('sale','return')
                 THEN CONCAT(type, ':', reference_type, ':', reference_id, ':',
                             variant_id, ':', stock_location_id)
                 WHEN type = 'release' AND operation_key IS NOT NULL
                 THEN CONCAT('release:', operation_key, ':',
                             variant_id, ':', stock_location_id)
                 ELSE NULL END
          ) STORED,
        ADD CONSTRAINT UC_STOCK_MOVEMENT_DEDUPE UNIQUE (movement_dedupe_key);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the two-arm expression exactly as `1783872387242` left it, then drop the
    // source column. Index first — MySQL refuses to drop a column an index depends on.
    await queryRunner.query('ALTER TABLE stock_movement DROP INDEX UC_STOCK_MOVEMENT_DEDUPE;');
    await queryRunner.query('ALTER TABLE stock_movement DROP COLUMN movement_dedupe_key;');
    await queryRunner.query(`
      ALTER TABLE stock_movement
        ADD COLUMN movement_dedupe_key VARCHAR(200)
          GENERATED ALWAYS AS (
            CASE WHEN type IN ('sale','return')
                 THEN CONCAT(type, ':', reference_type, ':', reference_id, ':',
                             variant_id, ':', stock_location_id)
                 ELSE NULL END
          ) STORED,
        ADD CONSTRAINT UC_STOCK_MOVEMENT_DEDUPE UNIQUE (movement_dedupe_key);
    `);
    await queryRunner.query('ALTER TABLE stock_movement DROP COLUMN operation_key;');
  }
}
