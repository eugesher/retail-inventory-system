import { MigrationInterface, QueryRunner } from 'typeorm';

// The DB-level guard behind the Commit Sale / Restock From Return idempotency claim
// (ADR-031 / ADR-032). Both use cases probe the ledger before they write — "has a
// movement already referenced this fulfillment / return request?" — but that probe is
// a READ outside the write transaction, and nothing in the schema enforced the
// uniqueness its answer assumed. Two deliveries of one RabbitMQ message, in flight at
// once, both read "absent" and both wrote. Retail calls both RPCs AFTER its own
// transaction has committed, precisely so a broker failure can redeliver, so this path
// is reached BY DESIGN; RabbitMQ never promises a redelivery waits for the original.
// Commit Sale then lost stock twice for one shipment (or threw a plain 500 the broker
// re-delivered in a hot loop); Restock invented stock that never came back. Nothing
// reconciles either — `stock_level`'s running totals ARE the balance authority and the
// ledger is explicitly not expected to reconstruct them (ADR-030 §2, "audit not
// balance"), so the damage was permanent and silent.
//
// `movement_dedupe_key` is a STORED generated column that is non-NULL only for the two
// idempotent movement types. MySQL has no partial unique index, so this emulates one:
// MySQL permits many NULLs under a UNIQUE, so every other movement (receipt, transfer,
// allocation, release) is simply not constrained. It is the `price.open_scope_key`
// technique (ADR-026), which `notification_delivery.delivery_dedupe_key` already
// reuses — this is its third application.
//
// **THE KEY REACHES THE LEVEL, NOT JUST THE REQUEST — and that is load-bearing.** One
// commit-sale writes one `sale` row PER LINE, all sharing a single `fulfillmentId`, so
// a key of `(type, reference_type, reference_id)` is IDENTICAL across the lines of one
// ordinary shipment and MySQL rejects the second line. Such a constraint breaks every
// shipment of more than one item — trading a rare race for a certain outage. The same
// holds for a multi-line restock. Adding `variant_id` + `stock_location_id` makes the
// key assert what the ledger actually means: *this* fulfillment moved *this* variant
// out of *this* location exactly once. `test/concurrent-commit-sale.e2e-spec.ts` pins
// both halves — the race AND the multi-line shipment that must keep working.
//
// The `type IN ('sale','return')` scope is load-bearing in the other direction: a
// TRANSFER writes TWO `adjustment` rows sharing one `transfer` reference id, so a
// UNIQUE over `(reference_type, reference_id, type)` would forbid transfers outright.
//
// `CONCAT` returns NULL when any argument is NULL, so a `sale`/`return` row somehow
// written without a reference falls out of the constraint on its own rather than
// colliding with every other reference-less row.
//
// Width: `'return'`(6) + `reference_type`(32) + `reference_id`(64) + `variant_id`
// (BIGINT UNSIGNED → 20 digits) + `stock_location_id`(64) + 4 separators = 190.
// VARCHAR(200) covers it, and at 4 bytes/char stays far under InnoDB's 3072-byte
// index-key limit.
export class AddStockMovementDedupeKey1783872387242 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
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
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The UNIQUE is an index over the generated column, so it must go first — MySQL
    // refuses to drop a column an index still depends on.
    await queryRunner.query('ALTER TABLE stock_movement DROP INDEX UC_STOCK_MOVEMENT_DEDUPE;');
    await queryRunner.query('ALTER TABLE stock_movement DROP COLUMN movement_dedupe_key;');
  }
}
