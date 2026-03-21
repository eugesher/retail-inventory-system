import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  JoinColumn,
  ManyToOne,
} from 'typeorm';

import { OrderProductStatusEnum } from '@retail-inventory-system/retail';
import { Order } from './order.entity';
import { OrderProductStatus } from './order-product-status.entity';

@Entity('order_product')
export class OrderProduct {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public productId: number;

  @Column()
  public orderId: number;

  @Column({
    type: 'enum',
    enum: OrderProductStatusEnum,
    default: OrderProductStatusEnum.PENDING,
  })
  public statusId: OrderProductStatusEnum;

  @ManyToOne(() => Order, ({ products }) => products)
  @JoinColumn({ name: 'order_id' })
  public order: Order;

  @ManyToOne(() => OrderProductStatus)
  @JoinColumn({ name: 'status_id' })
  public status: OrderProductStatus;

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;
}
