import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSkippedNoConsentDeliveryStatus1783269124759 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE notification_delivery
        MODIFY COLUMN status
          ENUM('queued','sent','delivered','failed','bounced','skipped-no-consent')
          NOT NULL DEFAULT 'queued';
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE notification_delivery
        MODIFY COLUMN status
          ENUM('queued','sent','delivered','failed','bounced')
          NOT NULL DEFAULT 'queued';
    `);
  }
}
