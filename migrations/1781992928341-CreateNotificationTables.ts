import { MigrationInterface, QueryRunner } from 'typeorm';

// Creates the notification microservice's first two tables — `notification_template`
// (the versioned, per `(event_type, channel, locale)` registry that backs every
// rendered notification) and `notification_delivery` (the queryable audit trail of one
// outgoing notification) — in the shared `retail_db`
// (docs/adr/033-notification-templates-deliveries-and-render-dispatch.md).
//
// Both keep `BaseEntity`'s numeric PK widened to BIGINT UNSIGNED (`synchronize` is off,
// so this migration is the source of truth) plus `created_at` / `updated_at` /
// `deleted_at`. `deleted_at` stays INERT on both: a template is soft-deleted via the
// `active` flag, a delivery is live-ephemeral (a `RETENTION_DELIVERY_DAYS` purge is a
// deferred future capability) — neither is ever soft-deleted.
//
// `notification_template.version` is the BUSINESS version (a plain INT that climbs on
// every edit — old rows retained for audit/rollback), part of the natural key, NOT an
// optimistic-lock token; the registry ships no OCC column (last-writer-wins, the catalog
// stance). The UNIQUE `(event_type, channel, locale, version)` makes every version a
// distinct retained row; the `(event_type, channel, locale, active)` index backs the
// "find latest active" hot-path query.
//
// `notification_delivery.template_id` FKs `notification_template(id)` `ON DELETE
// RESTRICT` so deliveries outlive template-edit churn. The **double-dispatch guard** is
// the STORED generated column `delivery_dedupe_key`: MySQL has no partial unique index,
// so (following the `price.open_scope_key` precedent) the column is non-NULL only when
// `recipient_customer_id IS NOT NULL`, and a UNIQUE index over it permits at most one
// customer-facing delivery per `(event_reference_type, event_reference_id, channel,
// recipient_customer_id)` — two consumers racing the same event collide on the INSERT,
// the loser catches `ER_DUP_ENTRY`. System/ops notifications (`recipient_customer_id IS
// NULL`) carry a NULL key and are NOT deduped (MySQL treats multiple NULLs as distinct,
// so each low-stock alert is a fresh row). The column is computed by MySQL — no
// application code ever writes it.
export class CreateNotificationTables1781992928341 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE notification_template (
        id          BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        event_type  VARCHAR(64) NOT NULL,
        channel     ENUM('email','sms','push','webhook') NOT NULL,
        locale      VARCHAR(10) NOT NULL,
        subject     TEXT NULL,
        body        TEXT NOT NULL,
        version     INT NOT NULL,
        active      TINYINT(1) NOT NULL DEFAULT 1,
        created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at  TIMESTAMP NULL,
        CONSTRAINT UC_NOTIFICATION_TEMPLATE_NATURAL_KEY
          UNIQUE (event_type, channel, locale, version)
      );
    `);
    await queryRunner.query(
      'CREATE INDEX IDX_NOTIFICATION_TEMPLATE_LATEST_ACTIVE ON notification_template (event_type, channel, locale, active);',
    );

    await queryRunner.query(`
      CREATE TABLE notification_delivery (
        id                    BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        template_id           BIGINT UNSIGNED NOT NULL,
        recipient_customer_id VARCHAR(64) NULL,
        recipient_address     VARCHAR(255) NOT NULL,
        channel               ENUM('email','sms','push','webhook') NOT NULL,
        event_reference_type  VARCHAR(32) NOT NULL,
        event_reference_id    VARCHAR(64) NOT NULL,
        status                ENUM('queued','sent','delivered','failed','bounced')
                                NOT NULL DEFAULT 'queued',
        attempt_count         INT NOT NULL DEFAULT 0,
        last_attempt_at       TIMESTAMP NULL,
        failure_reason        TEXT NULL,
        rendered_subject      TEXT NULL,
        rendered_body         TEXT NOT NULL,
        correlation_id        VARCHAR(64) NOT NULL,
        delivery_dedupe_key   VARCHAR(255) GENERATED ALWAYS AS (
                                CASE WHEN recipient_customer_id IS NOT NULL
                                     THEN CONCAT(event_reference_type, ':', event_reference_id, ':',
                                                 channel, ':', recipient_customer_id)
                                     ELSE NULL END
                              ) STORED,
        created_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at            TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        deleted_at            TIMESTAMP NULL,
        CONSTRAINT UC_NOTIFICATION_DELIVERY_DEDUPE UNIQUE (delivery_dedupe_key),
        CONSTRAINT FK_NOTIFICATION_DELIVERY_TEMPLATE FOREIGN KEY (template_id)
          REFERENCES notification_template (id) ON DELETE RESTRICT
      );
    `);
    // The retry sweeper scan: `status = 'failed' AND attempt_count < max`, ordered by
    // `last_attempt_at` (oldest-first).
    await queryRunner.query(
      'CREATE INDEX IDX_NOTIFICATION_DELIVERY_RETRY ON notification_delivery (status, last_attempt_at);',
    );
    // Audit lookups by the triggering business event.
    await queryRunner.query(
      'CREATE INDEX IDX_NOTIFICATION_DELIVERY_EVENT ON notification_delivery (event_reference_type, event_reference_id);',
    );
    // Per-customer delivery history, newest-first.
    await queryRunner.query(
      'CREATE INDEX IDX_NOTIFICATION_DELIVERY_RECIPIENT ON notification_delivery (recipient_customer_id, created_at);',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Drop in reverse FK order: `notification_delivery` (FKs `notification_template`),
    // then `notification_template`.
    await queryRunner.query('DROP TABLE IF EXISTS notification_delivery;');
    await queryRunner.query('DROP TABLE IF EXISTS notification_template;');
  }
}
