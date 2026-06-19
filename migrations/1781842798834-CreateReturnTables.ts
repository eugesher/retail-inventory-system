import { MigrationInterface, QueryRunner } from 'typeorm';

// Creates the `return_request` + `return_line` tables — the RMA (Return Merchandise
// Authorization) record that drives a delivered/shipped order's return through a
// six-state lifecycle (docs/adr/032-returns-and-refunds-rma-lifecycle-and-restock.md).
// A `ReturnRequest` is the root of its own retail bounded context (`modules/returns/`),
// so `order_id` is a plain BIGINT column under the `FK_RETURN_REQUEST_ORDER` foreign
// key rather than an owned-child relation — the same shape `fulfillment.order_id` /
// `payment.order_id` use.
//
// `customer_id` is the gateway customer's CHAR(36) UUID (the buyer, copied from the
// order) under `FK_RETURN_REQUEST_CUSTOMER → customer(id)` — mirroring how
// `order.customer_id` references the gateway `customer` aggregate (ADR-024). It is a
// CHAR(36), NOT a BIGINT, because the auth `customer` PK is a UUID; the table is
// `utf8mb4_unicode_ci` (like `order` / `customer`) so the string FK collations match.
// Unlike `order.customer_id` (nullable, `ON DELETE SET NULL` tombstone) it is NOT NULL
// and `ON DELETE RESTRICT` — a return is an append-only audit record of who returned
// what, so the buyer is required and a customer with a return on file cannot be
// hard-deleted out from under it.
//
// An order with several returns owns several `return_request` rows; each `return_line`
// says which `order_line` quantity is coming back, with the inspection outcome
// (`condition` / `disposition` / `line_refund_amount_minor`) recorded later — all three
// nullable until the warehouse inspects. `rma_number` is the human-facing
// `RMA-<year>-<pad8(id)>` written in a second UPDATE once the auto-increment id is known
// (the `order_number` idiom); it is nullable in the schema only so the insert-then-
// finalize works (MySQL allows multiple NULLs under a UNIQUE index). The `version`
// column is the per-RMA optimistic-concurrency token (the forward-provisioning
// `order.version` / `fulfillment.version` precedent — retrofitting OCC onto a populated
// table is a destructive `ALTER`).
//
// Tables are created in FK-dependency order — `return_request` first (the line
// references it), then `return_line`. `return_line.return_request_id → return_request.id`
// is `ON DELETE CASCADE` (a line cannot outlive its request), while
// `order_id → order.id`, `customer_id → customer.id`, and `order_line_id → order_line.id`
// are `ON DELETE RESTRICT` (a return never strands its order / order line / buyer —
// `return_request` is append-only, rejection/closure are `status` flips). `order` and
// `condition` are reserved words, backticked. `deleted_at` exists on both tables because the entities
// extend `BaseEntity` (TypeORM appends `deleted_at IS NULL` to every `find`) — it stays
// INERT, a return is never soft-deleted.
export class CreateReturnTables1781842798834 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE return_request (
        id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        rma_number      VARCHAR(20)  NULL,
        order_id        BIGINT UNSIGNED NOT NULL,
        customer_id     CHAR(36)     NOT NULL,
        status          ENUM('requested','authorized','rejected','received','inspected','closed')
                          NOT NULL DEFAULT 'requested',
        reason_category ENUM('defective','not-as-described','changed-mind','wrong-item') NOT NULL,
        notes           TEXT         NULL,
        requested_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        authorized_at   TIMESTAMP    NULL,
        closed_at       TIMESTAMP    NULL,
        version         INT          NOT NULL DEFAULT 0,
        created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at      TIMESTAMP    NULL,
        CONSTRAINT UC_RETURN_REQUEST_RMA_NUMBER UNIQUE (rma_number),
        CONSTRAINT FK_RETURN_REQUEST_ORDER FOREIGN KEY (order_id)
          REFERENCES \`order\` (id) ON DELETE RESTRICT,
        CONSTRAINT FK_RETURN_REQUEST_CUSTOMER FOREIGN KEY (customer_id)
          REFERENCES customer (id) ON DELETE RESTRICT
      ) COLLATE = utf8mb4_unicode_ci;
    `);
    await queryRunner.query(
      'CREATE INDEX IDX_RETURN_REQUEST_ORDER_REQUESTED ON return_request (order_id, requested_at DESC);',
    );
    await queryRunner.query(
      'CREATE INDEX IDX_RETURN_REQUEST_CUSTOMER_REQUESTED ON return_request (customer_id, requested_at DESC);',
    );

    await queryRunner.query(`
      CREATE TABLE return_line (
        id                       BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        return_request_id        BIGINT UNSIGNED NOT NULL,
        order_line_id            BIGINT UNSIGNED NOT NULL,
        quantity                 INT          NOT NULL,
        \`condition\`            ENUM('new','damaged','used') NULL,
        disposition              ENUM('restock','scrap','quarantine') NULL,
        line_refund_amount_minor BIGINT UNSIGNED NULL,
        created_at               TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at               TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at               TIMESTAMP    NULL,
        CONSTRAINT FK_RETURN_LINE_REQUEST FOREIGN KEY (return_request_id)
          REFERENCES return_request (id) ON DELETE CASCADE,
        CONSTRAINT FK_RETURN_LINE_ORDER_LINE FOREIGN KEY (order_line_id)
          REFERENCES order_line (id) ON DELETE RESTRICT
      ) COLLATE = utf8mb4_unicode_ci;
    `);
    await queryRunner.query(
      'CREATE INDEX IDX_RETURN_LINE_ORDER_LINE ON return_line (order_line_id);',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse FK order: `return_line` (FKs `return_request` / `order_line`),
    // then `return_request` (FKs `order` / `customer`).
    await queryRunner.query('DROP TABLE IF EXISTS return_line;');
    await queryRunner.query('DROP TABLE IF EXISTS return_request;');
  }
}
