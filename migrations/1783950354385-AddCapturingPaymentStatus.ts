import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCapturingPaymentStatus1783950354385 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE payment
        MODIFY COLUMN status
          ENUM('authorized','capturing','captured','voided','refunded','failed') NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const [{ stranded }] = (await queryRunner.query(
      'SELECT COUNT(*) AS stranded FROM payment WHERE status = ?;',
      ['capturing'],
    )) as [{ stranded: number }];
    if (Number(stranded) > 0) {
      throw new Error(
        `AddCapturingPaymentStatus.down: ${stranded} payment row(s) are still 'capturing'. ` +
          'Each may or may not have been charged at the gateway — resolve them before reverting, ' +
          'because neither `authorized` nor `captured` is a safe guess.',
      );
    }

    await queryRunner.query(`
      ALTER TABLE payment
        MODIFY COLUMN status
          ENUM('authorized','captured','voided','refunded','failed') NOT NULL;
    `);
  }
}
