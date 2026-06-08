import { Column, Entity, VersionColumn } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';

// Per-location running totals for one variant. `BaseEntity` supplies the BIGINT
// UNSIGNED `id` (the migration widens the `@PrimaryGeneratedColumn()` int to
// BIGINT — `synchronize` is off, so the migration is the source of truth) plus
// `createdAt` / `updatedAt` / `deletedAt`. `deletedAt` stays INERT (ADR-027).
//
// `variantId` is mapped as a plain BIGINT scalar with NO `@ManyToOne` relation:
// the inventory module must not import the catalog `ProductVariantEntity` (the
// forbidden cross-module import; ADR-004 / ADR-017). The FK that ties this
// column to `product_variant(id)` lives only in the migration (ADR-026
// precedent).
//
// SnakeNamingStrategy maps `variantId` → `variant_id`, `stockLocationId` →
// `stock_location_id`, `quantityOnHand` → `quantity_on_hand`, etc. (ADR-019).
@Entity('stock_level')
export class StockLevelEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public variantId: number;

  @Column({ type: 'varchar', length: 64 })
  public stockLocationId: string;

  @Column({ type: 'int', default: 0 })
  public quantityOnHand: number;

  @Column({ type: 'int', default: 0 })
  public quantityAllocated: number;

  @Column({ type: 'int', default: 0 })
  public quantityReserved: number;

  // Optimistic-concurrency token. TypeORM owns the persisted value via
  // `@VersionColumn` (incremented on each managed save); the no-oversell
  // invariant it guards is enforced by the later inventory-reservation +
  // concurrency-hardening capabilities. Shipping the column now keeps that
  // retrofit non-destructive — no future `ALTER TABLE` on a populated table.
  @VersionColumn()
  public version: number;
}
