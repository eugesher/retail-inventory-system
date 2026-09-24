import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('idempotency_key')
export class IdempotencyKeyEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  public scope: string;

  @PrimaryColumn({ type: 'varchar', length: 64 })
  public key: string;

  @Column({ type: 'char', length: 64 })
  public requestFingerprint: string;

  @Column({ type: 'int', nullable: true })
  public responseStatus: number | null;

  @Column({ type: 'json', nullable: true })
  public responseBody: Record<string, unknown> | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @Column({ type: 'timestamp' })
  public expiresAt: Date;
}
