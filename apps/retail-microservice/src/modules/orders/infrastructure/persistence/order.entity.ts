import { Column, Entity, OneToMany, VersionColumn } from 'typeorm';

import {
  OrderFulfillmentStatusEnum,
  OrderPaymentStatusEnum,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

import { OrderLineEntity } from './order-line.entity';

@Entity('order')
export class OrderEntity extends BaseEntity {
  @Column({ type: 'varchar', length: 20 })
  public orderNumber: string;

  @Column({ type: 'char', length: 36, nullable: true })
  public customerId: string | null;

  @Column({ type: 'char', length: 3 })
  public currency: string;

  @Column({ type: 'enum', enum: OrderStatusEnum, default: OrderStatusEnum.PENDING })
  public status: OrderStatusEnum;

  @Column({
    type: 'enum',
    enum: OrderPaymentStatusEnum,
    default: OrderPaymentStatusEnum.NONE,
  })
  public paymentStatus: OrderPaymentStatusEnum;

  @Column({
    type: 'enum',
    enum: OrderFulfillmentStatusEnum,
    default: OrderFulfillmentStatusEnum.UNFULFILLED,
  })
  public fulfillmentStatus: OrderFulfillmentStatusEnum;

  @Column({ type: 'bigint' })
  public subtotalMinor: number;

  @Column({ type: 'bigint', default: 0 })
  public taxTotalMinor: number;

  @Column({ type: 'bigint', default: 0 })
  public discountTotalMinor: number;

  @Column({ type: 'bigint', default: 0 })
  public shippingTotalMinor: number;

  @Column({ type: 'bigint' })
  public grandTotalMinor: number;

  @Column({ type: 'char', length: 36, nullable: true })
  public billingAddressId: string | null;

  @Column({ type: 'char', length: 36, nullable: true })
  public shippingAddressId: string | null;

  @Column({ type: 'char', length: 36, nullable: true })
  public sourceCartId: string | null;

  @Column({ type: 'timestamp', nullable: true })
  public placedAt: Date | null;

  @VersionColumn()
  public version: number;

  @OneToMany(() => OrderLineEntity, (line) => line.order)
  public lines: OrderLineEntity[];
}
