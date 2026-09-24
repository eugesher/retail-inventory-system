import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';

import { FulfillmentEntity } from './fulfillment.entity';

@Entity('fulfillment_line')
export class FulfillmentLineEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public orderLineId: number;

  @Column({ type: 'int' })
  public quantity: number;

  @ManyToOne(() => FulfillmentEntity, (fulfillment) => fulfillment.lines, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'fulfillment_id' })
  public fulfillment: FulfillmentEntity;
}
