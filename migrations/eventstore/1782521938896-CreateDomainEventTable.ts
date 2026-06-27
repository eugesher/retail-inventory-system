import { MigrationInterface, QueryRunner } from 'typeorm';

// Creates the `domain_event` table — the append-only firehose log of EVERY business
// event published in the system, captured from the `ris.events` topic exchange
// (docs/adr/035-event-store-firehose-topic-exchange.md). It lives in the ISOLATED
// `ris_eventstore` schema (docs/adr/034-isolated-eventstore-database.md), NOT the
// operational `retail_db`, so the high-volume write-mostly stream never pressures the
// hot path. This migration runs under the separate eventstore data-source
// (`migration:run:eventstore`).
//
// The log is APPEND-ONLY: rows are INSERTed and never updated or deleted. Unlike the
// `stock_movement` ledger this table carries NO `updated_at` / `deleted_at` columns at
// all (the domain instance is frozen, the repository exposes only `append` + reads via
// `insert`) — only `received_at`, the DB-assigned ingest instant, beside `occurred_at`,
// the producer's emit time threaded from the wire payload. Both are TIMESTAMP(3) for
// millisecond resolution.
//
// The composite UNIQUE `(producer, event_type, aggregate_id, occurred_at,
// correlation_id)` is the IDEMPOTENCY ANCHOR against RabbitMQ at-least-once redelivery
// (ADR-020): a redelivered event collides and the repository swallows the
// `ER_DUP_ENTRY` as a no-op. MySQL treats NULLs as DISTINCT in a UNIQUE index, so the
// ingest coalesces an empty wire `correlationId` to `''` (not NULL) before append so a
// redelivery actually collides — the column stays nullable per the wire contract, the
// coalescing lives in the ingest use case (a later capability). The three secondary
// indexes back future query paths (by aggregate, by event type, by correlation).
//
// No FK on any column: the firehose references no other schema and lives in its own
// isolated database.
export class CreateDomainEventTable1782521938896 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE domain_event (
        id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        event_type      VARCHAR(64)  NOT NULL,
        aggregate_type  VARCHAR(32)  NOT NULL,
        aggregate_id    VARCHAR(64)  NOT NULL,
        payload         JSON         NOT NULL,
        event_version   VARCHAR(8)   NOT NULL,
        producer        VARCHAR(32)  NOT NULL,
        correlation_id  VARCHAR(64)  NULL,
        occurred_at     TIMESTAMP(3) NOT NULL,
        received_at     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        CONSTRAINT UC_DOMAIN_EVENT_IDEMPOTENCY
          UNIQUE (producer, event_type, aggregate_id, occurred_at, correlation_id)
      );
    `);

    // "What happened to this aggregate, newest first?" — a MySQL 8 DESCENDING index on
    // the trailing timestamp so the scan is served straight from the index.
    await queryRunner.query(
      'CREATE INDEX IDX_DOMAIN_EVENT_AGGREGATE ON domain_event (aggregate_type, aggregate_id, occurred_at DESC);',
    );
    // "Give me every event of this type, newest first."
    await queryRunner.query(
      'CREATE INDEX IDX_DOMAIN_EVENT_TYPE ON domain_event (event_type, occurred_at DESC);',
    );
    // The cross-service-trace join (the `listByCorrelationId` read path).
    await queryRunner.query(
      'CREATE INDEX IDX_DOMAIN_EVENT_CORRELATION ON domain_event (correlation_id);',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS domain_event;');
  }
}
