import { Column, Entity, VersionColumn } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';

@Entity('stock_level')
export class StockLevelEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public variantId: number;

  @Column({ type: 'varchar', length: 64 })
  public stockLocationId: string;

  @Column({ type: 'int', default: 0 })
  public quantityOnHand: number;

  @Column({ type: 'int', default: 0 })
  public quantityAllocated: number;

  @Column({ type: 'int', default: 0 })
  public quantityReserved: number;

  @VersionColumn()
  public version: number;
}
