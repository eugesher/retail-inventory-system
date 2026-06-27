import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

// One captured row of the `ris.events` firehose, in the isolated `ris_eventstore`
// schema (ADR-034 / ADR-035).
//
// It deliberately does NOT extend `@retail-inventory-system/database`'s `BaseEntity`.
// `BaseEntity` carries `created_at` / `updated_at` / `deleted_at`, but this is a
// pure append-only log: there is no soft-delete and no update, so `updated_at` /
// `deleted_at` MUST NOT exist (append-only is stronger here than the `StockMovement`
// "inert by construction" stance — the mutation columns are simply absent). It also
// has its own ingest timestamp `received_at` rather than `created_at`. So the entity
// declares its own BIGINT PK and only the columns the firehose row needs.
//
// `payload` is the opaque captured event body (JSON). `occurred_at` is the PRODUCER's
// emit time threaded from the wire; `received_at` is the DB-assigned ingest instant
// (`CURRENT_TIMESTAMP(3)`) — the two differ by the bus + ingest latency. Both are
// TIMESTAMP(3) (millisecond precision) because `occurred_at` participates in the
// idempotency UNIQUE key and millisecond resolution keeps near-simultaneous events
// distinct.
//
// The UNIQUE idempotency key + the read indexes live ONLY in the migration (the source
// of truth with `synchronize` off — the `StockMovementEntity` convention). SnakeNaming
// maps `eventType` → `event_type`, `aggregateId` → `aggregate_id`, etc. (ADR-019).
@Entity('domain_event')
export class DomainEventEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  public id: number;

  @Column({ type: 'varchar', length: 64 })
  public eventType: string;

  @Column({ type: 'varchar', length: 32 })
  public aggregateType: string;

  @Column({ type: 'varchar', length: 64 })
  public aggregateId: string;

  @Column({ type: 'json' })
  public payload: Record<string, unknown>;

  @Column({ type: 'varchar', length: 8 })
  public eventVersion: string;

  @Column({ type: 'varchar', length: 32 })
  public producer: string;

  // Nullable per the wire contract, BUT the ingest coalesces an empty wire
  // `correlationId` to `''` (not NULL) so a redelivery actually collides on the
  // idempotency UNIQUE (MySQL treats NULLs as distinct) — that coalescing is the
  // ingest use case's job in a later capability; the column stays nullable here.
  @Column({ type: 'varchar', length: 64, nullable: true })
  public correlationId: string | null;

  @Column({ type: 'timestamp', precision: 3 })
  public occurredAt: Date;

  @Column({ type: 'timestamp', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  public receivedAt: Date;
}
