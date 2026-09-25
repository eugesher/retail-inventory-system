import { Column, Entity } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';

@Entity('price')
export class PriceEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public variantId: number;

  @Column({ type: 'char', length: 3 })
  public currency: string;

  @Column({ type: 'bigint' })
  public amountMinor: number;

  @Column({ type: 'timestamp' })
  public validFrom: Date;

  @Column({ type: 'timestamp', nullable: true })
  public validTo: Date | null;

  @Column({ type: 'int', default: 0 })
  public priority: number;
}
