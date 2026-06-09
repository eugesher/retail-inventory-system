import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';

import { CartEntity } from './cart.entity';

// The owning cart is mapped through the `@ManyToOne` relation alone (its
// `@JoinColumn` is the `cart_id` FK) — there is no separate `cartId` scalar
// column. A string-FK twin-mapping (a `char(36)` scalar *and* a join column on
// the same `cart_id`) trips TypeORM's metadata validator ("does not support
// length property") because the join column and the scalar disagree on type;
// `ProductVariantEntity`'s twin-mapping works only because its FK is numeric. A
// `CartLine` is a child entity that never carries its parent's id in the domain,
// so the relation-only mapping is also the truer shape.
//
// `variantId` is mapped as a plain BIGINT scalar with NO `@ManyToOne` relation:
// the retail module must not import the catalog `ProductVariantEntity` (the
// forbidden cross-module import; ADR-004 / ADR-017). The FK that ties this column
// to `product_variant(id)` lives only in the migration (ADR-026/027 precedent).
//
// `BaseEntity` supplies the BIGINT `id` (the migration widens the
// `@PrimaryGeneratedColumn()` int to BIGINT — `synchronize` is off, so the
// migration is the source of truth) plus `createdAt` / `updatedAt` / `deletedAt`.
// `deletedAt` stays INERT (a removed line is hard-deleted by the repository, not
// soft-deleted). SnakeNamingStrategy maps `unitPriceSnapshotMinor` →
// `unit_price_snapshot_minor`, etc. (ADR-019).
@Entity('cart_line')
export class CartLineEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public variantId: number;

  @Column({ type: 'int' })
  public quantity: number;

  // Minor units (integer cents). BIGINT so a large catalogue price never
  // overflows; mysql2 returns non-PK BIGINTs as strings, so the mapper coerces
  // back with `Number(...)`.
  @Column({ type: 'bigint' })
  public unitPriceSnapshotMinor: number;

  @Column({ type: 'char', length: 3 })
  public currencySnapshot: string;

  @ManyToOne(() => CartEntity, (cart) => cart.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'cart_id' })
  public cart: CartEntity;
}
