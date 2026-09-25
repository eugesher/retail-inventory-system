import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';

import { OrderLineStatusEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

import { OrderEntity } from './order.entity';

@Entity('order_line')
export class OrderLineEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public variantId: number;

  @Column({ type: 'varchar', length: 64 })
  public sku: string;

  @Column({ type: 'varchar', length: 255 })
  public nameSnapshot: string;

  @Column({ type: 'int' })
  public quantity: number;

  @Column({ type: 'int', default: 0 })
  public cancelledQuantity: number;

  @Column({ type: 'bigint' })
  public unitPriceMinor: number;

  @Column({ type: 'bigint', default: 0 })
  public taxAmountMinor: number;

  @Column({ type: 'bigint', default: 0 })
  public discountAmountMinor: number;

  @Column({ type: 'bigint' })
  public lineTotalMinor: number;

  @Column({ type: 'enum', enum: OrderLineStatusEnum, default: OrderLineStatusEnum.ALLOCATED })
  public status: OrderLineStatusEnum;

  @ManyToOne(() => OrderEntity, (order) => order.lines, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  public order: OrderEntity;
}
