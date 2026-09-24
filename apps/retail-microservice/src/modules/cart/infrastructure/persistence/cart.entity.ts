import { Column, Entity, OneToMany, PrimaryColumn, VersionColumn } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';
import { CartStatusEnum } from '@retail-inventory-system/contracts';

import { CartLineEntity } from './cart-line.entity';

const CartBaseEntity: abstract new () => Omit<BaseEntity, 'id'> = BaseEntity;

@Entity('cart')
export class CartEntity extends CartBaseEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  public id: string;

  @Column({ type: 'char', length: 36, nullable: true })
  public customerId: string | null;

  @Column({ type: 'char', length: 3 })
  public currency: string;

  @Column({ type: 'enum', enum: CartStatusEnum, default: CartStatusEnum.ACTIVE })
  public status: CartStatusEnum;

  @Column({ type: 'timestamp', nullable: true })
  public expiresAt: Date | null;

  @VersionColumn()
  public version: number;

  @OneToMany(() => CartLineEntity, (line) => line.cart)
  public lines: CartLineEntity[];
}
