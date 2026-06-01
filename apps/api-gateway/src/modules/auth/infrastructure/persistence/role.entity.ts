import {
  Column,
  CreateDateColumn,
  Entity,
  JoinTable,
  ManyToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import { PermissionEntity } from './permission.entity';

@Entity('role')
export class RoleEntity {
  @PrimaryColumn('char', { length: 36 })
  public id: string;

  @Column('varchar', { length: 64, unique: true })
  public name: string;

  @Column('varchar', { length: 255, nullable: true })
  public description: string | null;

  // The `role_permissions` join is owned on this side; eager loading
  // stays off — repository adapters request `relations: ['permissions']`
  // when they actually need the bound codes.
  @ManyToMany(() => PermissionEntity, { eager: false, cascade: false })
  @JoinTable({
    name: 'role_permissions',
    joinColumn: { name: 'role_id', referencedColumnName: 'id' },
    inverseJoinColumn: { name: 'permission_id', referencedColumnName: 'id' },
  })
  public permissions: PermissionEntity[];

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;
}
