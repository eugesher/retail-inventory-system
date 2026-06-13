import { MigrationInterface, QueryRunner } from 'typeorm';

// Creates the `reservation` table: a TTL-bounded, cart-scoped hold on stock for one
// variant at one location (docs/adr/030-reservation-ttl-aggregate-and-stock-movement-ledger.md).
// While a hold is `active` its `quantity` is counted into
// `stock_level.quantity_reserved`, so it is subtracted from `available` — this is
// what stops two carts racing for the last unit before either checks out.
//
// `id` is a CHAR(36) UUID generated in-app by `Reservation.create` (not the
// project's auto-increment integer PK — the `cart` / `address` precedent).
// `variant_id`, `stock_location_id`, and `cart_id` are real cross-service FKs in
// the one shared MySQL database (`ON DELETE RESTRICT` — a referenced variant /
// location / cart cannot be deleted out from under a live hold); the columns stay
// semantically OPAQUE to the inventory domain (no entity import, the FK is the only
// coupling — ADR-027 / ADR-028). `version` ships now (TypeORM `@VersionColumn`); the
// no-oversell guard it feeds runs inside the bounded optimistic write protocol the
// Reserve / Allocate use cases add. `deleted_at` exists because the entity extends
// `BaseEntity`; it stays INERT — a hold's lifecycle is its `status`, never a
// soft-delete timestamp.
//
// COLLATION: a string FK requires the referencing and referenced columns to share
// charset AND collation. This table FKs onto two different collation families:
// `stock_location` / `product_variant` are at the server default
// (`utf8mb4_0900_ai_ci` on MySQL 8.4), while `cart` is `utf8mb4_unicode_ci` (it
// matches the auth `customer` table). One table-level COLLATE cannot satisfy both,
// so the table is left at the server default (matching the inventory family it
// belongs to) and only `cart_id` is overridden per-column to `utf8mb4_unicode_ci`
// to match `cart.id`.
export class CreateReservationTable1781309334478 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE reservation (
        id                CHAR(36)        NOT NULL PRIMARY KEY,
        variant_id        BIGINT UNSIGNED NOT NULL,
        stock_location_id VARCHAR(64)     NOT NULL,
        quantity          INT             NOT NULL,
        cart_id           CHAR(36)        NOT NULL COLLATE utf8mb4_unicode_ci,
        expires_at        TIMESTAMP       NOT NULL,
        status            ENUM('active','committed','released','expired') NOT NULL DEFAULT 'active',
        version           INT             NOT NULL DEFAULT 0,
        created_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at        TIMESTAMP       NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at        TIMESTAMP       NULL,
        -- The idempotency anchor. The triple spans ALL statuses, which is why the
        -- domain has \`reactivate\`: a released/expired row for the triple is reused,
        -- never duplicated, when a removed cart line is re-added.
        CONSTRAINT UC_RESERVATION_CART_VARIANT_LOCATION UNIQUE (cart_id, variant_id, stock_location_id),
        CONSTRAINT FK_RESERVATION_VARIANT FOREIGN KEY (variant_id)
          REFERENCES product_variant (id) ON DELETE RESTRICT,
        CONSTRAINT FK_RESERVATION_LOCATION FOREIGN KEY (stock_location_id)
          REFERENCES stock_location (id) ON DELETE RESTRICT,
        CONSTRAINT FK_RESERVATION_CART FOREIGN KEY (cart_id)
          REFERENCES cart (id) ON DELETE RESTRICT,
        -- MySQL 8.4 enforces CHECK (the \`stock_level\` / \`cart_line\` precedent).
        CONSTRAINT CK_RESERVATION_QTY CHECK (quantity > 0)
      );
    `);

    // The future background sweeper scans for stale active holds by expiry; both
    // indexes serve that scan (the composite one narrows to a status first).
    await queryRunner.query('CREATE INDEX IDX_RESERVATION_EXPIRES_AT ON reservation (expires_at);');
    await queryRunner.query(
      'CREATE INDEX IDX_RESERVATION_STATUS_EXPIRES_AT ON reservation (status, expires_at);',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS reservation;');
  }
}
