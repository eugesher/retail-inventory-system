import { Column, Entity } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';

// A tax-category classification label. `BaseEntity` supplies the INT UNSIGNED
// `id` (`@PrimaryGeneratedColumn()` int — the migration matches) plus the
// timestamps; `deletedAt` stays INERT — a tax category is a static label, never
// soft-deleted (ADR-026).
//
// Global `code` uniqueness is enforced by the `UC_TAX_CATEGORY_CODE` UNIQUE
// constraint in the migration plus a use-case pre-check, not by this entity.
//
// SnakeNamingStrategy needs no `@Column({ name })` overrides — every field is a
// single word.
@Entity('tax_category')
export class TaxCategoryEntity extends BaseEntity {
  @Column({ type: 'varchar', length: 50 })
  public code: string;

  @Column({ type: 'varchar', length: 255 })
  public name: string;

  @Column({ type: 'varchar', length: 1000, nullable: true })
  public description: string | null;
}
