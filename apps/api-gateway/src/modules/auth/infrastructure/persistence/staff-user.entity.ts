import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinTable,
  ManyToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { RoleEntity } from './role.entity';

@Entity('staff_user')
export class StaffUserEntity {
  @PrimaryColumn('char', { length: 36 })
  public id: string;

  @Column('varchar', { length: 255 })
  public email: string;

  @Column('varchar', { length: 255 })
  public passwordHash: string;

  @Column({ type: 'enum', enum: ['active', 'suspended'], default: 'active' })
  public status: 'active' | 'suspended';

  @Column({ type: 'timestamp', nullable: true })
  public lastLoginAt: Date | null;

  @Column('varchar', { length: 255, nullable: true })
  public refreshTokenHash: string | null;

  // The `staff_user_roles` join is owned on this side. Eager loading stays
  // off — `StaffUserTypeormRepository` requests `relations: ['roles',
  // 'roles.permissions']` on every read so the mapped `StaffUser` carries
  // the inflated permission set.
  @ManyToMany(() => RoleEntity, { eager: false, cascade: false })
  @JoinTable({
    name: 'staff_user_roles',
    joinColumn: { name: 'staff_user_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'role_id', referencedColumnName: 'id' },
  })
  public roles: RoleEntity[];

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;

  @DeleteDateColumn({ nullable: true })
  public deletedAt: Date | null;
}
