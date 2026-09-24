import { Column, Entity, OneToMany } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';

import { ProductStatusEnum } from '../../domain';
import { ProductVariantEntity } from './product-variant.entity';

@Entity('product')
export class ProductEntity extends BaseEntity {
  @Column({ type: 'varchar', length: 255 })
  public name: string;

  @Column({ type: 'varchar', length: 255 })
  public slug: string;

  @Column({ type: 'text', nullable: true })
  public description: string | null;

  @Column({ type: 'enum', enum: ProductStatusEnum, default: ProductStatusEnum.DRAFT })
  public status: ProductStatusEnum;

  @OneToMany(() => ProductVariantEntity, (variant) => variant.product)
  public variants: ProductVariantEntity[];
}
