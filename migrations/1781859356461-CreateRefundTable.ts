import { MigrationInterface, QueryRunner } from 'typeorm';

// Creates the `refund` table — the record of one gateway refund interaction against a
// captured `payment` (docs/adr/032-returns-and-refunds-rma-lifecycle-and-restock.md).
// `Refund` is its own aggregate root inside the retail `orders/` module (a sibling of
// `Payment` — its operations mutate `Payment`, walking its status and incrementing
// `refunded_amount_minor`), so `order_id` and `payment_id` are plain BIGINT columns
// under the `FK_REFUND_ORDER` / `FK_REFUND_PAYMENT` foreign keys rather than
// owned-child relations — the same shape `payment.order_id` uses for its opaque FK.
//
// A `Refund` is **distinct from a `ReturnRequest`**: a refund must be able to exist
// with no return behind it (a chargeback, a goodwill credit, a partial price
// adjustment, or a refund Cancel Order issues on an order that never shipped), so it
// is modeled as its own entity that a return *triggers* rather than a field a return
// *contains*.
//
// `status` is the refund-row lifecycle ENUM — a row only ever exists because Issue
// Refund opened it `pending`, then it walks to `issued` (the gateway succeeded) or
// `failed` (the gateway declined — terminal). `gateway_reference` / `issued_at` are
// nullable (both null while `pending`, stamped on issue). `amount_minor` is BIGINT
// minor units (mysql2 returns it as a string — the mapper coerces with `Number(...)`).
// Both FKs are `ON DELETE RESTRICT` — a refund is an append-only audit record of money
// returned, so neither its order nor its payment can be hard-deleted out from under it.
// `deleted_at` exists because `RefundEntity` extends `BaseEntity` (TypeORM appends
// `deleted_at IS NULL` to every `find`) — it stays INERT, a refund is never
// soft-deleted (a decline is a `status` flip). `utf8mb4_unicode_ci` so the implicit
// collation matches the rest of the schema. The `(order_id)` and `(payment_id)` indexes
// back the `findByOrderId` / `findByPaymentId` history reads.
export class CreateRefundTable1781859356461 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE refund (
        id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        order_id          BIGINT UNSIGNED NOT NULL,
        payment_id        BIGINT UNSIGNED NOT NULL,
        amount_minor      BIGINT       NOT NULL,
        currency          CHAR(3)      NOT NULL,
        status            ENUM('pending','issued','failed') NOT NULL DEFAULT 'pending',
        reason            VARCHAR(255) NOT NULL,
        gateway_reference VARCHAR(255) NULL,
        issued_at         TIMESTAMP    NULL,
        created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at        TIMESTAMP    NULL,
        CONSTRAINT FK_REFUND_ORDER FOREIGN KEY (order_id)
          REFERENCES \`order\` (id) ON DELETE RESTRICT,
        CONSTRAINT FK_REFUND_PAYMENT FOREIGN KEY (payment_id)
          REFERENCES payment (id) ON DELETE RESTRICT
      ) COLLATE = utf8mb4_unicode_ci;
    `);
    await queryRunner.query('CREATE INDEX IDX_REFUND_ORDER ON refund (order_id);');
    await queryRunner.query('CREATE INDEX IDX_REFUND_PAYMENT ON refund (payment_id);');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS refund;');
  }
}
