import { Entity, Column, PrimaryColumn, Index } from 'typeorm';

@Entity('product_stock')
export class ProductStock {
  @PrimaryColumn()
  public productId: string;

  @PrimaryColumn()
  @Index()
  public storeId: string;

  @Column({ type: 'int', default: 0 })
  public quantity: number;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP', onUpdate: 'CURRENT_TIMESTAMP' })
  public updatedAt: Date;
}
