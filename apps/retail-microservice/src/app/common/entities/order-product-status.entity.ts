import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { OrderProductStatusEnum } from '@retail-inventory-system/retail';

@Entity('order_product_status')
export class OrderProductStatus {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  public id: OrderProductStatusEnum;

  @Column()
  public name: string;

  @Column({ type: 'char', length: 6 })
  public color: string;

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;
}
