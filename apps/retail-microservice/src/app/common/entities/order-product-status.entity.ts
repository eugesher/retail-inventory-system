import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('order_product_status')
export class OrderProductStatus {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  public id: string;

  @Column()
  public name: string;

  @Column({ type: 'char', length: 6 })
  public color: string;

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;
}
