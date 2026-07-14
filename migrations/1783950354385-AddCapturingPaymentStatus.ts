import { MigrationInterface, QueryRunner } from 'typeorm';

// Adds `capturing` to `payment.status` — the durable capture claim (ADR-052).
//
// Both paths that take money (`CapturePaymentUseCase`, and the ship-triggered capture inside
// `ShipFulfillmentUseCase`) used to check `status = 'authorized'` on an **unlocked** read and then
// call the payment gateway. Two callers could pass that check at the same instant and charge the
// same authorization twice; the loser then threw `PAYMENT_INVALID_STATUS_TRANSITION` and rolled its
// transaction back — and a rollback **cannot un-call a payment processor**. A concurrent cancel had
// its own version of the same hole: it voided a payment whose capture was already in flight, so the
// customer was charged for an order the database recorded as cancelled and never captured
// (ISSUE-05 / ISSUE-07).
//
// `capturing` is written **under a `SELECT … FOR UPDATE`, in a committed transaction, before the
// gateway is called.** The loser of the race blocks on the row, wakes to find `capturing` rather than
// `authorized`, and is rejected while the money is still the customer's. Cancel refuses it too.
//
// **It is the only non-terminal payment status**, and a row left in it is *evidence*: a crash between
// the claim and the completion means nobody knows whether the charge landed, and the gateway offers
// no way to ask. `StaleCaptureClaimScheduler` surfaces such rows for an operator. **Nothing releases
// them automatically** — releasing a claim whose charge did land is how the double charge comes back.
//
// The column is a MySQL ENUM, so a new member is a `MODIFY COLUMN` of the whole value list; the
// order of the list is not semantic. No row can already hold the new value, so the `up` needs no
// backfill and the `down` needs no data migration — but the `down` DOES have to reckon with rows
// stranded in `capturing`, and it cannot: it fails loudly rather than silently rewriting an unknown
// number of in-flight charges into `authorized` (see below).
export class AddCapturingPaymentStatus1783950354385 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE payment
        MODIFY COLUMN status
          ENUM('authorized','capturing','captured','voided','refunded','failed') NOT NULL;
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // **Refuse to reverse while a claim is outstanding.** Narrowing the ENUM would coerce every
    // `capturing` row to `''` (MySQL's silent truncation for an invalid ENUM value, or an error under
    // STRICT mode) — and each of those rows is a payment that may or may not have been charged. There
    // is no correct value to pick: `authorized` invites a second charge, `captured` claims money that
    // may never have moved. An operator must resolve them first, which is exactly what the scheduler
    // exists to make possible.
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
