import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('consent_record')
export class ConsentRecordEntity {
  @PrimaryColumn('char', { length: 36 })
  public customerId: string;

  @Column({ type: 'boolean', default: true })
  public transactionalEmail: boolean;

  @Column({ type: 'boolean', default: false })
  public marketingEmail: boolean;

  @Column({ type: 'boolean', default: false })
  public marketingSms: boolean;

  @Column({ type: 'varchar', length: 32, default: 'default-7-years' })
  public dataRetentionPolicy: string;

  @UpdateDateColumn()
  public updatedAt: Date;
}
