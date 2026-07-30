import { Column, Entity } from 'typeorm';

import { StockMovementTypeEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

// One immutable row of the audit ledger (ADR-030 §2).
//
// **`updatedAt` and `deletedAt` are INERT.** They exist only because the entity extends
// `BaseEntity`; the ledger is append-only and nothing writes them after the INSERT. A row whose
// `updated_at` differs from its `created_at` is evidence of a bug, not of an edit.
//
// **The schema is the migration, not this file.** `synchronize` is off, so the BIGINT widening of
// the `id`, every index, and the FK on `variant_id` all live there — and `variant_id` is a plain
// scalar here because inventory may not import the catalog entity. `referenceId` is polymorphic and
// carries **no FK at all**: do not join on it.
//
// **`movement_dedupe_key` is deliberately NOT mapped here** (the `price.open_scope_key` precedent,
// ADR-026). It is a STORED generated column and a DB-internal idempotency backstop: with
// `synchronize` off TypeORM never touches it, and an INSERT that omits it lets MySQL compute it.
// Mapping it would make TypeORM try to WRITE a generated column, which MySQL rejects. It is not
// missing — it is the guard that makes Commit Sale and Restock From Return idempotent against a
// concurrent redelivery (migration `1783872387242`).
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

  // The caller-minted identity of the cancellation that produced a `release` row (ADR-057).
  // Null for every other producer — and that null is what keeps those rows out of
  // `UC_STOCK_MOVEMENT_DEDUPE`, since the generated key is NULL without it.
  @Column({ type: 'varchar', length: 64, nullable: true })
  public operationKey: string | null;

  @Column({ type: 'timestamp', default: () => 'CURRENT_TIMESTAMP' })
  public occurredAt: Date;
}
