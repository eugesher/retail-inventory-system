import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';

import { OrderLineStatusEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

import { OrderEntity } from './order.entity';

// One line of a placed order. The owning order is mapped through the `@ManyToOne`
// relation alone (its `@JoinColumn` is the `order_id` FK) — there is no separate
// `orderId` scalar column. A child entity does not carry its parent's id in the
// domain, so the relation-only mapping is the truer shape (the same shape
// `CartLineEntity` uses). `order_id` is numeric, so a twin scalar+relation mapping
// would also be legal here, but the relation-only form keeps the two line tables
// consistent.
//
// `variantId` is mapped as a plain BIGINT scalar with NO `@ManyToOne` relation: the
// retail module must not import the catalog `ProductVariantEntity` (the forbidden
// cross-module import; ADR-004 / ADR-017). The FK that ties this column to
// `product_variant(id)` lives only in the migration (ADR-026/027 precedent).
//
// `BaseEntity` supplies the BIGINT `id` (the migration widens the
// `@PrimaryGeneratedColumn()` int to BIGINT) plus `createdAt` / `updatedAt` /
// `deletedAt`. `deletedAt` stays INERT — an order line is append-only, never
// soft-deleted. Every other column is a place-time snapshot; SnakeNamingStrategy
// maps `nameSnapshot` → `name_snapshot`, etc. (ADR-019).
@Entity('order_line')
export class OrderLineEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public variantId: number;

  @Column({ type: 'varchar', length: 64 })
  public sku: string;

  @Column({ type: 'varchar', length: 255 })
  public nameSnapshot: string;

  @Column({ type: 'int' })
  public quantity: number;

  // Minor units (integer cents); mysql2 returns non-PK BIGINTs as strings, so the
  // mapper coerces back with `Number(...)`. Tax/discount default 0 in this
  // capability, so `line_total_minor = unit_price_minor × quantity`.
  @Column({ type: 'bigint' })
  public unitPriceMinor: number;

  @Column({ type: 'bigint', default: 0 })
  public taxAmountMinor: number;

  @Column({ type: 'bigint', default: 0 })
  public discountAmountMinor: number;

  @Column({ type: 'bigint' })
  public lineTotalMinor: number;

  @Column({ type: 'enum', enum: OrderLineStatusEnum, default: OrderLineStatusEnum.ALLOCATED })
  public status: OrderLineStatusEnum;

  @ManyToOne(() => OrderEntity, (order) => order.lines, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  public order: OrderEntity;
}
