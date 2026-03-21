import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  JoinColumn,
  ManyToOne,
  OneToMany,
} from 'typeorm';

import { OrderStatusEnum } from '@retail-inventory-system/retail';
import { OrderProduct } from './order-product.entity';
import { OrderStatus } from './order-status.entity';

@Entity('order')
export class Order {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public customerId: number;

  @Column({
    type: 'enum',
    enum: OrderStatusEnum,
  })
  public statusId: OrderStatusEnum;

  @ManyToOne(() => OrderStatus)
  @JoinColumn({ name: 'status_id' })
  public status: OrderStatus;

  @OneToMany(() => OrderProduct, ({ order }) => order, { cascade: ['insert', 'update'] })
  public products: OrderProduct[];

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;
}
