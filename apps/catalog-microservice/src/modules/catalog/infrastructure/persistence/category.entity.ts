import { Column, Entity } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';

import { CategoryStatusEnum } from '../../domain';

// `BaseEntity` supplies `id` / `createdAt` / `updatedAt` / `deletedAt`. The
// `deletedAt` soft-delete path is never invoked — category lifecycle is driven
// by `status` (ADR-025 / ADR-029) — but the column is inherited so it exists on
// the row.
//
// `parentId` is a PLAIN nullable scalar (a root has `parent_id IS NULL`); the
// DB-level self-FK in the migration is the real referential guard. No
// self-`@ManyToOne` relation is mapped because every read path here is flat
// (`listAll` / `listSubtree` read the materialized `path`, never a parent graph),
// so an ORM relation would be unused metadata. The repository writes the scalar.
//
// SnakeNamingStrategy maps the camelCase fields to snake_case columns
// (`parentId` → `parent_id`, `sortOrder` → `sort_order`); no `@Column({ name })`
// overrides are needed (ADR-019).
@Entity('category')
export class CategoryEntity extends BaseEntity {
  @Column({ type: 'varchar', length: 255 })
  public name: string;

  @Column({ type: 'varchar', length: 255 })
  public slug: string;

  // Explicit `type: 'bigint'` (not a bare `@Column`): a `number | null` union
  // reflects as `Object`, which TypeORM cannot map — the type must be named. A
  // BIGINT scalar mapped as a TS `number`, mirroring `PriceEntity.variantId`
  // (mysql2 surfaces non-PK BIGINTs as strings on read; the mapper coerces).
  @Column({ type: 'bigint', unsigned: true, nullable: true })
  public parentId: number | null;

  @Column({ type: 'varchar', length: 512 })
  public path: string;

  @Column({ type: 'int', default: 0 })
  public sortOrder: number;

  @Column({ type: 'enum', enum: CategoryStatusEnum, default: CategoryStatusEnum.ACTIVE })
  public status: CategoryStatusEnum;
}
