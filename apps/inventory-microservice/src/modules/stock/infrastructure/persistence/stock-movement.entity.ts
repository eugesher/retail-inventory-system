import { Column, Entity } from 'typeorm';

import { StockMovementTypeEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

// One immutable row of the inventory audit ledger (ADR-030 §2). `BaseEntity`
// supplies the BIGINT UNSIGNED `id` (the migration widens the
// `@PrimaryGeneratedColumn()` int to BIGINT — `synchronize` is off, so the
// migration is the source of truth) plus `createdAt` / `updatedAt` / `deletedAt`.
//
// `updatedAt` and `deletedAt` are **INERT by construction**: the ledger is
// append-only, so a row is never updated and never soft-deleted. They exist only
// because the entity extends `BaseEntity`; nothing ever writes them after the
// initial INSERT.
//
// `variantId` is mapped as a plain BIGINT scalar with NO `@ManyToOne` relation
// (the inventory module must not import the catalog `ProductVariantEntity` — the
// forbidden cross-module import, ADR-004 / ADR-017); the FK that ties it to
// `product_variant(id)` lives only in the migration. `referenceId` is polymorphic
// and carries NO FK at all (the `media_asset.owner_id` precedent, ADR-029). The
// table's indexes likewise live only in the migration (the source of truth with
// `synchronize` off — the `StockLevelEntity` / `ReservationEntity` convention).
//
// SnakeNamingStrategy maps `variantId` → `variant_id`, `stockLocationId` →
// `stock_location_id`, `reasonCode` → `reason_code`, `occurredAt` → `occurred_at`,
// etc. (ADR-019).
@Entity('stock_movement')
export class StockMovementEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public variantId: number;

  @Column({ type: 'varchar', length: 64 })
  public stockLocationId: string;

  @Column({ type: 'enum', enum: StockMovementTypeEnum })
  public type: StockMovementTypeEnum;

  // Signed: positive on receipt/return, negative on sale/allocation/release,
  // either sign on adjustment (the domain enforces the per-type sign).
  @Column({ type: 'int' })
  public quantity: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  public reasonCode: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  public referenceType: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  public referenceId: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  public actorId: string | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  public occurredAt: Date;
}
