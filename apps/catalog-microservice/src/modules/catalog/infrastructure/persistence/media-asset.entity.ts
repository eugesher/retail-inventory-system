import { Column, Entity, Index } from 'typeorm';

import { MediaAssetTypeEnum, MediaOwnerTypeEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

import { MediaAssetStatusEnum } from '../../domain';

// `BaseEntity` supplies `id` / `createdAt` / `updatedAt` / `deletedAt`. The
// `deletedAt` soft-delete path is never invoked — media lifecycle is driven by
// `status` (ADR-025 / ADR-029) — but the column is inherited so it exists on the
// row.
//
// `ownerId` is a PLAIN nullable-less BIGINT scalar with NO relation: the owner is
// POLYMORPHIC over `product` / `product_variant`, and a foreign key cannot target
// two tables. Owner existence is the use case's job (a parameterized probe against
// the right table), and the composite `(owner_type, owner_id, sort_order)` index
// (declared in the migration, mirrored by `@Index` here for documentation) is the
// compensation for the missing FK — every read is owner-scoped (ADR-029 §4).
//
// SnakeNamingStrategy maps the camelCase fields to snake_case columns
// (`ownerType` → `owner_type`, `sortOrder` → `sort_order`); no `@Column({ name })`
// overrides are needed (ADR-019).
@Entity('media_asset')
@Index('IDX_MEDIA_ASSET_OWNER', ['ownerType', 'ownerId', 'sortOrder'])
export class MediaAssetEntity extends BaseEntity {
  @Column({ type: 'enum', enum: MediaOwnerTypeEnum })
  public ownerType: MediaOwnerTypeEnum;

  // Explicit `type: 'bigint'` BIGINT scalar mapped as a TS `number`, mirroring
  // `CategoryEntity.parentId` / `PriceEntity.variantId` (mysql2 surfaces non-PK
  // BIGINTs as strings on read; the mapper coerces with `Number(...)`).
  @Column({ type: 'bigint', unsigned: true })
  public ownerId: number;

  @Column({ type: 'varchar', length: 1024 })
  public uri: string;

  @Column({ type: 'enum', enum: MediaAssetTypeEnum })
  public type: MediaAssetTypeEnum;

  @Column({ type: 'varchar', length: 255, nullable: true })
  public altText: string | null;

  @Column({ type: 'int', default: 0 })
  public sortOrder: number;

  @Column({ type: 'enum', enum: MediaAssetStatusEnum, default: MediaAssetStatusEnum.ACTIVE })
  public status: MediaAssetStatusEnum;
}
