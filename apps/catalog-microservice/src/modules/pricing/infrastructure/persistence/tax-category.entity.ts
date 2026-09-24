import { Column, Entity } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';

@Entity('tax_category')
export class TaxCategoryEntity extends BaseEntity {
  @Column({ type: 'varchar', length: 50 })
  public code: string;

  @Column({ type: 'varchar', length: 255 })
  public name: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  public description: string | null;
}
