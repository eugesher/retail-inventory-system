import { MigrationInterface, QueryRunner } from 'typeorm';

// Widens the `notification_delivery.status` ENUM to add the terminal
// `skipped-no-consent` value (ADR-037). The consent-gate in the Render & Dispatch
// pipeline writes a delivery row directly in this status when a customer-facing
// dispatch's channel is unconsented — the row is an auditable record of a message
// that was deliberately NOT sent, so it needs a first-class status value distinct
// from `queued`/`sent`/`failed`.
//
// MySQL stores an ENUM as its ordinal set; adding a member at the END is a metadata
// change that leaves every existing row's stored value untouched (no table rewrite of
// the existing five members). `synchronize` stays off (ADR-019) — this migration owns
// the column shape. The `down` narrows it back to the original five-member set; it is
// safe only when no row currently holds `skipped-no-consent` (the start-from-scratch
// latitude — there is no production data to preserve).
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
