import { MigrationInterface, QueryRunner } from 'typeorm';

// Creates the `fulfillment` + `fulfillment_line` tables — the per-shipment record
// that drives a placed order from `pending`/`authorized` toward `delivered`
// (docs/adr/031-fulfillment-aggregate-and-ship-triggered-capture.md). A `Fulfillment`
// is its own aggregate root inside the retail checkout context (it lives in the
// `orders/` module because its operations act on the `Order` + `Payment` aggregates,
// but it has an independent per-shipment lifecycle), so `order_id` is a plain BIGINT
// column under the `FK_FULFILLMENT_ORDER` foreign key rather than an owned-child
// relation — the same shape `payment.order_id` uses (ADR-028 §4).
//
// An order with split / partial shipments owns several `fulfillment` rows; each
// `fulfillment_line` says which `order_line` quantity is in that shipment. The
// fulfillment carries its own four-value `status` ENUM (a *fourth* status axis beside
// the order's three orthogonal axes, ADR-028 §2) and a `version` optimistic-concurrency
// token (the same forward-provisioning `order.version` / `stock_level.version` used,
// ADR-028 §6 — retrofitting OCC onto a populated table is a destructive `ALTER`).
//
// `stock_location_id` is a plain VARCHAR scalar (the opaque inventory `stock_location`
// PK the shipment ships from) with **no FK** — retail never imports inventory, and a
// cross-service FK across bounded contexts is avoided (the `reservation`/movement
// opaque-id precedent, ADR-030). Tables are created in FK-dependency order —
// `fulfillment` first (the line references it), then `fulfillment_line`. `order` is a
// reserved word, backticked.
//
// `fulfillment_line.fulfillment_id → fulfillment.id` is `ON DELETE CASCADE` (a line
// cannot outlive its fulfillment), while `order_id → order.id` and
// `order_line_id → order_line.id` are `ON DELETE RESTRICT` (a fulfillment never
// strands its order / order line — `fulfillment` is append-only, cancellation is a
// `status` flip). `deleted_at` exists on both tables because the entities extend
// `BaseEntity` (TypeORM appends `deleted_at IS NULL` to every `find`) — it stays
// INERT, a fulfillment is never soft-deleted. `utf8mb4_unicode_ci` so the implicit
// collation matches the rest of the schema.
export class CreateFulfillmentTables1781491328025 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE fulfillment (
        id                BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        order_id          BIGINT UNSIGNED NOT NULL,
        stock_location_id VARCHAR(64)  NOT NULL,
        status            ENUM('pending','shipped','delivered','cancelled') NOT NULL DEFAULT 'pending',
        tracking_number   VARCHAR(64)  NULL,
        carrier           VARCHAR(64)  NULL,
        shipped_at        TIMESTAMP    NULL,
        delivered_at      TIMESTAMP    NULL,
        version           INT          NOT NULL DEFAULT 0,
        created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at        TIMESTAMP    NULL,
        CONSTRAINT FK_FULFILLMENT_ORDER FOREIGN KEY (order_id)
          REFERENCES \`order\` (id) ON DELETE RESTRICT
      ) COLLATE = utf8mb4_unicode_ci;
    `);
    await queryRunner.query(
      'CREATE INDEX IDX_FULFILLMENT_ORDER_SHIPPED ON fulfillment (order_id, shipped_at);',
    );

    await queryRunner.query(`
      CREATE TABLE fulfillment_line (
        id             BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        fulfillment_id BIGINT UNSIGNED NOT NULL,
        order_line_id  BIGINT UNSIGNED NOT NULL,
        quantity       INT          NOT NULL,
        created_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at     TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at     TIMESTAMP    NULL,
        CONSTRAINT FK_FULFILLMENT_LINE_FULFILLMENT FOREIGN KEY (fulfillment_id)
          REFERENCES fulfillment (id) ON DELETE CASCADE,
        CONSTRAINT FK_FULFILLMENT_LINE_ORDER_LINE FOREIGN KEY (order_line_id)
          REFERENCES order_line (id) ON DELETE RESTRICT
      ) COLLATE = utf8mb4_unicode_ci;
    `);
    await queryRunner.query(
      'CREATE INDEX IDX_FULFILLMENT_LINE_ORDER_LINE ON fulfillment_line (order_line_id);',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse FK order: `fulfillment_line` (FKs `fulfillment` / `order_line`),
    // then `fulfillment` (FKs `order`).
    await queryRunner.query('DROP TABLE IF EXISTS fulfillment_line;');
    await queryRunner.query('DROP TABLE IF EXISTS fulfillment;');
  }
}
