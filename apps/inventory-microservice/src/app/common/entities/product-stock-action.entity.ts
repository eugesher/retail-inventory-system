import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('product_stock_action')
export class ProductStockAction {
  @PrimaryColumn({ type: 'varchar', length: 36 })
  public id: string;

  @Column()
  public name: string;

  @CreateDateColumn()
  public createdAt: Date;

  @UpdateDateColumn()
  public updatedAt: Date;
}
