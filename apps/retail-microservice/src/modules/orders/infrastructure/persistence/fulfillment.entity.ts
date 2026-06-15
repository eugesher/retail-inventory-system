import { Column, Entity, OneToMany, VersionColumn } from 'typeorm';

import { FulfillmentStatusEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

import { FulfillmentLineEntity } from './fulfillment-line.entity';

// The per-shipment, per-location fulfillment row. It keeps `BaseEntity`'s generated
// numeric PK (the migration widens the `@PrimaryGeneratedColumn()` int to BIGINT
// UNSIGNED — `synchronize` is off, so the migration is the source of truth) plus
// `createdAt` / `updatedAt` / `deletedAt`. `deletedAt` stays INERT — a fulfillment is
// append-only; cancellation is a `status` flip to `cancelled`, never a soft-delete
// (ADR-031).
//
// `order_id` is a plain BIGINT scalar with **no `@ManyToOne`**: `Fulfillment` is its
// own aggregate root, not a child of `Order`, so a plain column + the
// `FK_FULFILLMENT_ORDER` foreign key (in the migration) is enough — the same shape
// `payment.order_id` uses (ADR-028 §4 / ADR-031). `stock_location_id` is the opaque
// inventory `stock_location` PK the shipment ships from — a plain VARCHAR scalar with
// **no `@ManyToOne`** (retail must not import inventory; a cross-service id, the
// `reservation.stock_location_id` precedent). `status` is the fulfillment's own
// (fourth) status ENUM; `tracking_number` / `carrier` / `shipped_at` / `delivered_at`
// are nullable (a shipment is planned-then-shipped-then-delivered).
//
// SnakeNamingStrategy maps the camelCase fields to snake_case columns
// (`stockLocationId` → `stock_location_id`, `trackingNumber` → `tracking_number`,
// etc.); no `@Column({ name })` overrides are needed (ADR-019). The `order_id` FK and
// the `(order_id, shipped_at)` index live in the migration.
@Entity('fulfillment')
export class FulfillmentEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public orderId: number;

  @Column({ type: 'varchar', length: 64 })
  public stockLocationId: string;

  @Column({ type: 'enum', enum: FulfillmentStatusEnum, default: FulfillmentStatusEnum.PENDING })
  public status: FulfillmentStatusEnum;

  @Column({ type: 'varchar', length: 64, nullable: true })
  public trackingNumber: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  public carrier: string | null;

  @Column({ type: 'timestamp', nullable: true })
  public shippedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  public deliveredAt: Date | null;

  // Optimistic-concurrency token. TypeORM owns the persisted value via
  // `@VersionColumn` (incremented on each managed save); the guard it enables is a
  // later concurrency-hardening capability. Shipping the column now keeps that
  // retrofit non-destructive (the `order.version` / ADR-028 §6 precedent).
  @VersionColumn()
  public version: number;

  // No TypeORM `cascade`: the repository drives line persistence explicitly inside
  // one transaction (root save → line save). The DB-level FK is `ON DELETE CASCADE`
  // (a fulfillment line cannot outlive its fulfillment) — but the fulfillment itself
  // is never hard-deleted, so the cascade is a safety net, not a routine path.
  @OneToMany(() => FulfillmentLineEntity, (line) => line.fulfillment)
  public lines: FulfillmentLineEntity[];
}
