import { MigrationInterface, QueryRunner } from 'typeorm';

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
                                     THEN CONCAT(template_id, ':', event_reference_type, ':',
                                                 event_reference_id, ':', channel, ':',
                                                 recipient_customer_id)
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
    await queryRunner.query(
      'CREATE INDEX IDX_NOTIFICATION_DELIVERY_RETRY ON notification_delivery (status, last_attempt_at);',
    );
    await queryRunner.query(
      'CREATE INDEX IDX_NOTIFICATION_DELIVERY_EVENT ON notification_delivery (event_reference_type, event_reference_id);',
    );
    await queryRunner.query(
      'CREATE INDEX IDX_NOTIFICATION_DELIVERY_RECIPIENT ON notification_delivery (recipient_customer_id, created_at);',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS notification_delivery;');
    await queryRunner.query('DROP TABLE IF EXISTS notification_template;');
  }
}
