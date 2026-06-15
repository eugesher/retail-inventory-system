import { MigrationInterface, QueryRunner } from 'typeorm';

// Adds the `flagged_for_refund` flag to `payment`. The column ships ahead of its
// writer (docs/adr/028-cart-order-payment-and-address-chain.md §6 — the
// `version`-ships-now precedent): cancelling an order whose payment was already
// captured will set this flag to mark that a refund is owed, and a later refund
// capability consumes it. Retrofitting a column onto a populated table later is a
// destructive `ALTER`, so it lands now while no production data exists.
//
// `TINYINT(1) NOT NULL DEFAULT 0` is MySQL's boolean — every existing row backfills
// to `0`/false (no payment has yet been flagged). `synchronize` stays off
// (docs/adr/019-typeorm-and-mysql-for-persistence.md); this hand-authored migration
// is the source of truth.
export class AddFlaggedForRefundToPayment1781487934305 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'ALTER TABLE payment ADD COLUMN flagged_for_refund TINYINT(1) NOT NULL DEFAULT 0;',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE payment DROP COLUMN flagged_for_refund;');
  }
}
