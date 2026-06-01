import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('customer')
export class CustomerEntity {
  @PrimaryColumn('char', { length: 36 })
  public id: string;

  @Column('varchar', { length: 255 })
  public email: string;

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

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;
}
