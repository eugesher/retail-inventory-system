import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('product_stock')
export class ProductStock {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public productId: number;

  @Column()
  public storageId: string;

  @Column()
  public quantity: number;

  @Column()
  public createdAt: Date;
}
