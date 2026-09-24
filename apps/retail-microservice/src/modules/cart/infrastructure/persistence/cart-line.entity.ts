import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';

import { CartEntity } from './cart.entity';

@Entity('cart_line')
export class CartLineEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public variantId: number;

  @Column({ type: 'int' })
  public quantity: number;

  @Column({ type: 'bigint' })
  public unitPriceSnapshotMinor: number;

  @Column({ type: 'char', length: 3 })
  public currencySnapshot: string;

  @ManyToOne(() => CartEntity, (cart) => cart.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cart_id' })
  public cart: CartEntity;
}
