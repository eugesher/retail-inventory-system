import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

import { AuditActorType } from '../../domain';

@Entity('audit_log_entry')
export class AuditLogEntryEntity {
  @PrimaryGeneratedColumn({ type: 'bigint', unsigned: true })
  public id: number;

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

  @Column({ type: 'varchar', length: 45, nullable: true })
  public ipAddress: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  public correlationId: string | null;

  @Column({ type: 'timestamp', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  public receivedAt: Date;
}
