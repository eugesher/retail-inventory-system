import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

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

  @Column({ type: 'varchar', length: 64, default: '' })
  public correlationId: string;

  @Column({ type: 'timestamp', precision: 3 })
  public occurredAt: Date;

  @Column({ type: 'timestamp', precision: 3, default: () => 'CURRENT_TIMESTAMP(3)' })
  public receivedAt: Date;
}
