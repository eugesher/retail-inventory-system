import { MigrationInterface, QueryRunner } from 'typeorm';

// Lays the tombstone-ready foundation for the consent-and-erasure capability
// (docs/adr/037-consent-record-and-tombstone-erasure.md). Three moves:
//
// 1. CREATE `consent_record` — one channel-consent row per customer, 1:1, keyed
//    on the customer's CHAR(36) UUID. No `BaseEntity` shape: no surrogate id, no
//    `version`, no `created_at` / `deleted_at` — only `updated_at` (the
//    `idempotency_key` / `domain_event` append-style precedent, ADR-036/034).
//    `transactional_email` defaults true (order-confirmation-style mail is
//    operationally required); the two marketing flags default false (opt-in — the
//    GDPR posture). The FK `ON DELETE CASCADE` means consent dies with the
//    customer row should it ever be hard-deleted — but per Q6 the row is never
//    hard-deleted (erase tombstones in place), so the CASCADE is a documented
//    safety net, not a live path.
//
// 2. Add `customer.deleted_at` (nullable TIMESTAMP) — the tombstone marker set on
//    erase; null for a live customer.
//
// 3. Relax the PII NOT NULL constraints that make a tombstone impossible today:
//    `customer.email` and the five `address` PII columns
//    (`recipient_name` / `line1` / `city` / `region` / `postal_code`) become
//    nullable so an erase can null them in place. The remaining PII columns
//    (`customer.phone` / `first_name` / `last_name` / `password_hash` /
//    `email_verified_at`; `address.line2` / `phone`) are already nullable.
//
// `consent_record` is created at `utf8mb4_unicode_ci` (matching `customer`) so the
// `customer_id` FK collation lines up with `customer.id` without a per-column
// override (the `return_request` precedent). `synchronize` stays off — this
// migration is the source of truth for the table shape (ADR-019).
export class AddConsentAndTombstoneColumns1783145019567 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE consent_record (
        customer_id           CHAR(36)     NOT NULL PRIMARY KEY,
        transactional_email   TINYINT(1)   NOT NULL DEFAULT 1,
        marketing_email       TINYINT(1)   NOT NULL DEFAULT 0,
        marketing_sms         TINYINT(1)   NOT NULL DEFAULT 0,
        data_retention_policy VARCHAR(32)  NOT NULL DEFAULT 'default-7-years',
        updated_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
          ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT FK_CONSENT_RECORD_CUSTOMER FOREIGN KEY (customer_id)
          REFERENCES customer (id) ON DELETE CASCADE
      ) COLLATE = utf8mb4_unicode_ci;
    `);

    await queryRunner.query('ALTER TABLE customer ADD COLUMN deleted_at TIMESTAMP NULL;');
    await queryRunner.query('ALTER TABLE customer MODIFY email VARCHAR(255) NULL;');

    await queryRunner.query('ALTER TABLE address MODIFY recipient_name VARCHAR(255) NULL;');
    await queryRunner.query('ALTER TABLE address MODIFY line1 VARCHAR(255) NULL;');
    await queryRunner.query('ALTER TABLE address MODIFY city VARCHAR(128) NULL;');
    await queryRunner.query('ALTER TABLE address MODIFY region VARCHAR(128) NULL;');
    await queryRunner.query('ALTER TABLE address MODIFY postal_code VARCHAR(32) NULL;');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Restore the NOT NULL constraints. This only succeeds on data with no nulls
    // in these columns — the pre-erase state — which is acceptable for a `down`
    // (no production data exists; the erase writer lands in later consent work).
    await queryRunner.query('ALTER TABLE address MODIFY postal_code VARCHAR(32) NOT NULL;');
    await queryRunner.query('ALTER TABLE address MODIFY region VARCHAR(128) NOT NULL;');
    await queryRunner.query('ALTER TABLE address MODIFY city VARCHAR(128) NOT NULL;');
    await queryRunner.query('ALTER TABLE address MODIFY line1 VARCHAR(255) NOT NULL;');
    await queryRunner.query('ALTER TABLE address MODIFY recipient_name VARCHAR(255) NOT NULL;');

    await queryRunner.query('ALTER TABLE customer MODIFY email VARCHAR(255) NOT NULL;');
    await queryRunner.query('ALTER TABLE customer DROP COLUMN deleted_at;');

    await queryRunner.query('DROP TABLE IF EXISTS consent_record;');
  }
}
