import { Column, Entity, PrimaryColumn, VersionColumn } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';

import { ReservationStatusEnum } from '../../domain';

// `reservation.id` is a caller-assigned CHAR(36) UUID string PK (generated in-app
// by `Reservation.create`), which diverges from `BaseEntity`'s auto-increment
// numeric `id`. A plain `extends BaseEntity` with `id: string` is a TS2416 type
// clash (`string` is not assignable to the inherited `number`); re-typing the
// `BaseEntity` constructor to drop its `id` lets us declare a string PK cleanly
// while still inheriting `createdAt` / `updatedAt` / `deletedAt`. `deletedAt`
// stays INERT — a reservation's lifecycle is its `status`, never a soft-delete
// timestamp (the catalog / pricing / stock convention; ADR-030). The same
// string-PK override `CartEntity` / `AddressEntity` / `StockLocationEntity` use.
const ReservationBaseEntity: abstract new () => Omit<BaseEntity, 'id'> = BaseEntity;

// A TTL-bounded, cart-scoped hold (ADR-030). `variant_id` is mapped as a plain
// BIGINT scalar with NO `@ManyToOne`, and `cart_id` as a plain CHAR(36) scalar:
// the inventory module must not import the catalog `ProductVariantEntity` or the
// retail `CartEntity` (the forbidden cross-module import; ADR-004 / ADR-017). The
// FKs that tie these columns to `product_variant(id)` / `cart(id)` /
// `stock_location(id)` live only in the migration (the `stock_level.variant_id`
// precedent).
//
// SnakeNamingStrategy maps `variantId` → `variant_id`, `stockLocationId` →
// `stock_location_id`, `cartId` → `cart_id`, `expiresAt` → `expires_at` (ADR-019).
@Entity('reservation')
export class ReservationEntity extends ReservationBaseEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  public id: string;

  @Column({ type: 'bigint', unsigned: true })
  public variantId: number;

  @Column({ type: 'varchar', length: 64 })
  public stockLocationId: string;

  @Column({ type: 'int' })
  public quantity: number;

  @Column({ type: 'char', length: 36 })
  public cartId: string;

  @Column({ type: 'timestamp' })
  public expiresAt: Date;

  @Column({ type: 'enum', enum: ReservationStatusEnum, default: ReservationStatusEnum.ACTIVE })
  public status: ReservationStatusEnum;

  // Optimistic-concurrency token. TypeORM owns the persisted value via
  // `@VersionColumn` (incremented on each managed save); the no-oversell invariant
  // it ultimately guards runs inside the bounded optimistic write protocol the
  // Reserve / Allocate use cases add (ADR-030 §4). The `StockLevelEntity`
  // precedent.
  @VersionColumn()
  public version: number;
}
