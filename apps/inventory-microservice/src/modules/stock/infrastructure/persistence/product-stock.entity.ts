import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('product_stock')
export class ProductStock {
  @PrimaryGeneratedColumn()
  public id: number;

  @Column()
  public productId: number;

  @Column()
  public storageId: string;

  @Column()
  public actionId: string;

  @Column()
  public quantity: number;

  @Column({ nullable: true, type: 'bigint' })
  public orderProductId: number | null;

  @CreateDateColumn()
  public createdAt: Date;
}
