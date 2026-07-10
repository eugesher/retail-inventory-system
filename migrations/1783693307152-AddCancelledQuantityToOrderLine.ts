import { MigrationInterface, QueryRunner } from 'typeorm';

// Adds `order_line.cancelled_quantity` — the persisted count of a line's units cancelled
// by Cancel Line (ADR-031).
//
// Before this column, Cancel Line released the cancelled quantity's stock allocation and
// recorded **nothing** on the order. The cancellable remainder was recomputed on every
// call as `ordered − alreadyFulfilled`, so the same units could be cancelled repeatedly,
// releasing their allocation each time (an unbounded over-release of `quantity_allocated`).
// The same blind spot let Create Fulfillment ship units whose allocation had already been
// released, and left the returns reader unable to exclude cancelled units from the
// returnable pool (it could only recognise a whole line at `status = 'cancelled'` — a
// status nothing ever wrote).
//
// The column is the single source of truth for "how much of this line is cancelled": the
// stock movements live in the inventory service's own ledger, unreachable from retail, so
// the count cannot be derived. `quantity − cancelled_quantity` is the line's **active**
// quantity — what remains shippable and returnable.
//
// `NOT NULL DEFAULT 0` backfills every existing row with "nothing cancelled", which is
// exactly true: no prior code path ever recorded a cancelled quantity. The CHECK mirrors
// the `OrderLine` domain invariant (`0 ≤ cancelled_quantity ≤ quantity`) at the storage
// layer — MySQL 8 enforces CHECK constraints, unlike 5.7 where they parsed as no-ops.
export class AddCancelledQuantityToOrderLine1783693307152 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE order_line
        ADD COLUMN cancelled_quantity INT NOT NULL DEFAULT 0 AFTER quantity;
    `);
    await queryRunner.query(`
      ALTER TABLE order_line
        ADD CONSTRAINT CHK_ORDER_LINE_CANCELLED_QUANTITY
        CHECK (cancelled_quantity >= 0 AND cancelled_quantity <= quantity);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE order_line DROP CONSTRAINT CHK_ORDER_LINE_CANCELLED_QUANTITY;
    `);
    await queryRunner.query(`
      ALTER TABLE order_line DROP COLUMN cancelled_quantity;
    `);
  }
}
