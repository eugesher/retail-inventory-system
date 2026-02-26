import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('product_stock')
export class ProductStock {
  @PrimaryColumn()
  public productId: string;

  @PrimaryColumn()
  public storeId: string;

  @Column()
  public quantity: number;

  @Column()
  public updatedAt: Date;
}
