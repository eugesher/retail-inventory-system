import { Column, Entity } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';

// One row of the append-only price ledger. `BaseEntity` supplies the BIGINT
// UNSIGNED `id` (the migration widens the `@PrimaryGeneratedColumn()` int to
// BIGINT — `synchronize` is off, so the migration is the source of truth) plus
// `createdAt` / `updatedAt` / `deletedAt`. `deletedAt` stays INERT — pricing is
// append-only and never soft-deletes (ADR-026), exactly as the catalog tables
// leave it inert.
//
// `variantId` is mapped as a plain BIGINT scalar with NO `@ManyToOne` relation:
// the pricing module must not import the catalog `ProductVariantEntity` (the
// forbidden cross-module import; ADR-004/ADR-017). The FK that ties this column
// to `product_variant(id)` lives only in the migration.
//
// `open_scope_key` (the generated-column UNIQUE backstop for the at-most-one-open
// invariant) is deliberately NOT mapped here — it is a DB-internal backstop;
// with `synchronize` off TypeORM never touches it, and an insert that omits it
// lets MySQL compute it (ADR-026).
//
// SnakeNamingStrategy maps `variantId` → `variant_id`, `amountMinor` →
// `amount_minor`, `validFrom` → `valid_from`, `validTo` → `valid_to` (ADR-019).
@Entity('price')
export class PriceEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public variantId: number;

  @Column({ type: 'char', length: 3 })
  public currency: string;

  @Column({ type: 'bigint' })
  public amountMinor: number;

  @Column({ type: 'timestamp' })
  public validFrom: Date;

  @Column({ type: 'timestamp', nullable: true })
  public validTo: Date | null;

  @Column({ type: 'int', default: 0 })
  public priority: number;
}
