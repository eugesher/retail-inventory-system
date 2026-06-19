import { MigrationInterface, QueryRunner } from 'typeorm';

// Adds the cumulative `refunded_amount_minor` counter to `payment`. The column
// ships ahead of its writer (docs/adr/028-cart-order-payment-and-address-chain.md
// §6 — the same `version` / `flagged_for_refund`-ships-now precedent): issuing a
// refund will increment this running total, and the partial-vs-full decision reads
// it against `amount_minor`. Retrofitting a column onto a populated table later is a
// destructive `ALTER`, so it lands now while no production data exists.
//
// `BIGINT UNSIGNED NOT NULL DEFAULT 0` mirrors `amount_minor` (minor units, an
// integer count of cents — never a float); every existing row backfills to `0`
// (no payment has been refunded). `synchronize` stays off
// (docs/adr/019-typeorm-and-mysql-for-persistence.md); this hand-authored migration
// is the source of truth.
export class AddRefundedAmountToPayment1781841074914 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE payment ADD COLUMN refunded_amount_minor BIGINT UNSIGNED NOT NULL DEFAULT 0;',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE payment DROP COLUMN refunded_amount_minor;');
  }
}
