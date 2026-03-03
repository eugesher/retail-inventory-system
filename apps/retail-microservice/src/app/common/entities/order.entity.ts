import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';
import { OrderStatusEnum } from '@retail-inventory-system/retail';

@Entity('order')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  public id: string;

  @Column()
  public customerId: string;

  @Column('json')
  public items: { productId: string; quantity: number; storeId?: string }[];

  @Column()
  public shippingAddress: string;

  @Column({ default: 0 })
  public total: number;

  @Column({ default: OrderStatusEnum.PENDING })
  public status: string;

  @CreateDateColumn()
  public createdAt: Date;
}
