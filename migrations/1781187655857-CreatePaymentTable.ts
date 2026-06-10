import { MigrationInterface, QueryRunner } from 'typeorm';

// Creates the `payment` table — the record of a gateway interaction for an order.
// `Payment` is its own aggregate root inside the retail checkout context (it lives
// in the `orders/` module because its operations touch the `Order` aggregate, but it
// has an independent lifecycle: authorized-on-place, captured-explicitly), so
// `order_id` is a plain BIGINT column under the `FK_PAYMENT_ORDER` foreign key
// rather than an owned-child relation
// (docs/adr/028-cart-order-payment-and-address-chain.md §4).
//
// `gateway_reference` is UNIQUE — each authorize mints a distinct opaque reference,
// so the column doubles as an idempotency guard against a duplicated gateway
// callback. `order_id → order.id` is `ON DELETE RESTRICT` (an order with a payment
// can never be deleted out from under it). `status` is the payment-row lifecycle
// ENUM (never `none` — a row only exists because an authorize succeeded);
// `authorized_at` / `captured_at` are nullable timestamps. `deleted_at` exists
// because `PaymentEntity` extends `BaseEntity` (TypeORM appends `deleted_at IS NULL`
// to every `find`) — it stays INERT, a payment is append-only, never soft-deleted.
//
// `utf8mb4_unicode_ci` so the implicit collation matches the rest of the schema; the
// money column is BIGINT minor units (mysql2 returns it as a string — the mapper
// coerces with `Number(...)`).
export class CreatePaymentTable1781187655857 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE payment (
        id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        order_id          BIGINT UNSIGNED NOT NULL,
        amount_minor      BIGINT       NOT NULL,
        currency          CHAR(3)      NOT NULL,
        method            VARCHAR(64)  NOT NULL,
        status            ENUM('authorized','captured','voided','refunded','failed') NOT NULL,
        gateway_reference VARCHAR(255) NOT NULL,
        authorized_at     TIMESTAMP    NULL,
        captured_at       TIMESTAMP    NULL,
        created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at        TIMESTAMP    NULL,
        CONSTRAINT UC_PAYMENT_GATEWAY_REFERENCE UNIQUE (gateway_reference),
        CONSTRAINT FK_PAYMENT_ORDER FOREIGN KEY (order_id)
          REFERENCES \`order\` (id) ON DELETE RESTRICT
      ) COLLATE = utf8mb4_unicode_ci;
    `);
    await queryRunner.query('CREATE INDEX IDX_PAYMENT_ORDER ON payment (order_id);');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS payment;');
  }
}
