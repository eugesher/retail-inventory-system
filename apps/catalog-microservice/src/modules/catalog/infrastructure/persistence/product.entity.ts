import { Column, Entity, OneToMany } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';

import { ProductStatusEnum } from '../../domain';
import { ProductVariantEntity } from './product-variant.entity';

// `BaseEntity` supplies `id` / `createdAt` / `updatedAt` / `deletedAt`. The
// `deletedAt` soft-delete path is never invoked — catalog lifecycle is driven
// by `status` (ADR-025) — but the column is inherited so it exists on the row.
//
// SnakeNamingStrategy maps the camelCase fields to snake_case columns; no
// `@Column({ name })` overrides are needed (ADR-019).
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

  // Cascade is off on purpose: variants are persisted explicitly through the
  // repository so the parent save and the child saves stay independent and the
  // ON DELETE RESTRICT FK is never bypassed by a cascading delete.
  @OneToMany(() => ProductVariantEntity, (variant) => variant.product)
  public variants: ProductVariantEntity[];
}
