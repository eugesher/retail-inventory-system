import { MigrationInterface, QueryRunner } from 'typeorm';

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
