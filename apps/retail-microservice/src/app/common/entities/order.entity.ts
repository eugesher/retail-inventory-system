import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';
import { OrderStatusEnum } from '@retail-inventory-system/retail';

@Entity('order')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  public id: string;

  @Column()
  public customerId: string;

  @Column('json')
  public items: { productId: string; quantity: number; storageId?: string }[];

  @Column()
  public shippingAddress: string;

  @Column({ default: 0 })
  public total: number;

  @Column({
    type: 'enum',
    enum: OrderStatusEnum,
    default: OrderStatusEnum.PENDING,
  })
  public status: OrderStatusEnum;

  @CreateDateColumn()
  public createdAt: Date;
}
