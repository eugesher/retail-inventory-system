import { Column, Entity } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';

import { CategoryStatusEnum } from '../../domain';

@Entity('category')
export class CategoryEntity extends BaseEntity {
  @Column({ type: 'varchar', length: 255 })
  public name: string;

  @Column({ type: 'varchar', length: 255 })
  public slug: string;

  @Column({ type: 'bigint', unsigned: true, nullable: true })
  public parentId: number | null;

  @Column({ type: 'varchar', length: 512 })
  public path: string;

  @Column({ type: 'int', default: 0 })
  public sortOrder: number;

  @Column({ type: 'enum', enum: CategoryStatusEnum, default: CategoryStatusEnum.ACTIVE })
  public status: CategoryStatusEnum;
}
