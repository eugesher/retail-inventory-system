import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  OneToMany,
} from 'typeorm';

import { OrderStatusEnum } from '@retail-inventory-system/retail';
import { OrderProduct } from './order-product.entity';

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

  @OneToMany(() => OrderProduct, ({ order }) => order, { cascade: ['insert', 'update'] })
  public products: OrderProduct[];

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;
}
