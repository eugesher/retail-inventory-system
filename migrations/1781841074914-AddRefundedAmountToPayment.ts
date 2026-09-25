import { MigrationInterface, QueryRunner } from 'typeorm';

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
