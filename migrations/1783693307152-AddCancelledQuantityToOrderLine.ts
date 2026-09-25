import { MigrationInterface, QueryRunner } from 'typeorm';

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
