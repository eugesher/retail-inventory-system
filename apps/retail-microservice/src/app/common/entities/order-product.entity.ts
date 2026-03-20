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

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;
}
