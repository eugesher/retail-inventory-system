import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

import { OrderStatusEnum } from '@retail-inventory-system/retail';

@Entity('order_status')
export class OrderStatus {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  public id: OrderStatusEnum;

  @Column()
  public name: string;

  @Column({ type: 'char', length: 6 })
  public color: string;

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;
}
