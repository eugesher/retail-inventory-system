import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('customer')
export class CustomerEntity {
  @PrimaryColumn('char', { length: 36 })
  public id: string;

  // Nullable so a tombstoned (`status='deleted'`) customer can have its email
  // nulled on erase while its id survives — the row *represents* the deletion
  // rather than being hard-deleted (ADR-028 §1). A live customer always carries
  // a real email (the model's status-conditional invariant enforces it).
  @Column('varchar', { length: 255, nullable: true })
  public email: string | null;

  @Column('varchar', { length: 32, nullable: true })
  public phone: string | null;

  @Column('varchar', { length: 128, nullable: true })
  public firstName: string | null;

  @Column('varchar', { length: 128, nullable: true })
  public lastName: string | null;

  @Column('varchar', { length: 255, nullable: true })
  public passwordHash: string | null;

  @Column({
    type: 'enum',
    enum: ['active', 'suspended', 'guest', 'deleted'],
    default: 'active',
  })
  public status: 'active' | 'suspended' | 'guest' | 'deleted';

  @Column({ type: 'timestamp', nullable: true })
  public emailVerifiedAt: Date | null;

  @Column('varchar', { length: 255, nullable: true })
  public refreshTokenHash: string | null;

  // The tombstone marker: null for a live customer, set to the erase instant for
  // a `status='deleted'` row. Distinct from the inert `BaseEntity.deletedAt`
  // convention — the `customer` table does not extend `BaseEntity`, and this is a
  // domain-meaningful erase timestamp, not a TypeORM soft-delete column.
  @Column({ type: 'timestamp', nullable: true })
  public deletedAt: Date | null;

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;
}
