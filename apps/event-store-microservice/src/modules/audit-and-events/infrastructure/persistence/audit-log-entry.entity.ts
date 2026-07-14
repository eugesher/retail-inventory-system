import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { AuditActorType } from '../../domain';

// One row of the staff audit trail, in the isolated `ris_eventstore` schema
// (ADR-034 / ADR-035) — the persisted shape of the wire `IAuditStaffActionEvent`.
//
// Like its `domain_event` sibling it deliberately does NOT extend `BaseEntity`: the
// log is pure append-only, so the `updated_at` / `deleted_at` columns `BaseEntity`
// carries MUST NOT exist (an editable or soft-deletable audit row is no audit at all).
// It declares its own BIGINT PK and an ingest timestamp `received_at` (the DB-assigned
// instant the entry was captured) alongside `occurred_at` (the producer's action time).
//
// `actor_type` is a two-value ENUM; `before` / `after` are JSON state snapshots
// (nullable — many events carry neither). The read indexes live ONLY in the migration
// (the source of truth with `synchronize` off — the `StockMovementEntity` convention).
// SnakeNaming maps `actorId` → `actor_id`, `entityType` → `entity_type`, etc. (ADR-019).
@Entity('audit_log_entry')
export class AuditLogEntryEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  public id: number;

  // Null for pre-auth / system-origin events (e.g. `LoginFailed`, the
  // auto-refund-from-cancel path).
  @Column({ type: 'varchar', length: 64, nullable: true })
  public actorId: string | null;

  @Column({ type: 'enum', enum: ['staff-user', 'system'] })
  public actorType: AuditActorType;

  @Column({ type: 'varchar', length: 64 })
  public action: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  public entityType: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  public entityId: string | null;

  @Column({ type: 'json', nullable: true })
  public before: Record<string, unknown> | null;

  @Column({ type: 'json', nullable: true })
  public after: Record<string, unknown> | null;

  @Column({ type: 'timestamp', precision: 3 })
  public occurredAt: Date;

  // Sized for an IPv6 literal (max 45 chars); always null today — no call site threads
  // the request IP through (a documented gap, ADR-035).
  @Column({ type: 'varchar', length: 45, nullable: true })
  public ipAddress: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  public correlationId: string | null;

  @Column({ type: 'timestamp', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  public receivedAt: Date;
}
