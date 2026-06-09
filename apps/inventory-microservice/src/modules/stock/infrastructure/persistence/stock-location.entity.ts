import { Column, Entity, PrimaryColumn } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';

import { StockLocationTypeEnum } from '../../domain';

// `stock_location.id` is a caller-assigned VARCHAR(64) string PK
// (`default-warehouse`), which diverges from `BaseEntity`'s auto-increment
// numeric `id`. A plain `extends BaseEntity` with `id: string` is a TS2416
// type clash (`string` is not assignable to the inherited `number`). Re-typing
// the `BaseEntity` constructor to drop its `id` lets us declare a string PK
// cleanly while still inheriting the `createdAt` / `updatedAt` / `deletedAt`
// columns from the prototype metadata. `deletedAt` stays INERT — soft-delete is
// via the `active` flag, never a timestamp (ADR-027).
const StockLocationBaseEntity: abstract new () => Omit<BaseEntity, 'id'> = BaseEntity;

@Entity('stock_location')
export class StockLocationEntity extends StockLocationBaseEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  public id: string;

  @Column({ type: 'varchar', length: 255 })
  public name: string;

  // Global uniqueness is enforced by the `UC_STOCK_LOCATION_CODE` UNIQUE
  // constraint in the migration, not by this entity (ADR-025 convention).
  @Column({ type: 'varchar', length: 64 })
  public code: string;

  @Column({
    type: 'enum',
    enum: StockLocationTypeEnum,
    default: StockLocationTypeEnum.WAREHOUSE,
  })
  public type: StockLocationTypeEnum;

  @Column({ type: 'json', nullable: true })
  public address: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 13, nullable: true })
  public gln: string | null;

  @Column({ type: 'boolean', default: true })
  public active: boolean;
}
