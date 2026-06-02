import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';

import { ProductVariantStatusEnum } from '../../domain';
import { ProductEntity } from './product.entity';

// A variant carries an explicit `productId` scalar column alongside the
// `@ManyToOne` relation (both target the `product_id` column) — the same
// twin-mapping the `order_product` entity uses for `orderId`/`order`. The
// scalar is what the repository writes; the relation is for graph reads.
//
// `optionValues` and `dimensionsMm` are JSON columns (the first JSON columns in
// the schema). SnakeNamingStrategy maps `optionValues` → `option_values`,
// `weightG` → `weight_g`, `dimensionsMm` → `dimensions_mm`, `productId` →
// `product_id` (ADR-019), so no `@Column({ name })` overrides are needed.
@Entity('product_variant')
export class ProductVariantEntity extends BaseEntity {
  @Column()
  public productId: number;

  @Column({ type: 'varchar', length: 255 })
  public sku: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  public gtin: string | null;

  @Column({ type: 'json' })
  public optionValues: Record<string, string>;

  @Column({ type: 'int', nullable: true })
  public weightG: number | null;

  @Column({ type: 'json', nullable: true })
  public dimensionsMm: { l: number; w: number; h: number } | null;

  @Column({
    type: 'enum',
    enum: ProductVariantStatusEnum,
    default: ProductVariantStatusEnum.ACTIVE,
  })
  public status: ProductVariantStatusEnum;

  @ManyToOne(() => ProductEntity, (product) => product.variants)
  @JoinColumn({ name: 'product_id' })
  public product: ProductEntity;
}
