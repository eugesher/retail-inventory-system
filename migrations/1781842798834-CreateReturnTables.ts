import { MigrationInterface, QueryRunner } from 'typeorm';

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
    await queryRunner.query('DROP TABLE IF EXISTS return_line;');
    await queryRunner.query('DROP TABLE IF EXISTS return_request;');
  }
}
