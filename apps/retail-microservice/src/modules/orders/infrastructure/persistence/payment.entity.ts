import { Column, Entity } from 'typeorm';

import { PaymentStatusEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

// The payment row. It keeps `BaseEntity`'s generated numeric PK (the migration
// widens the `@PrimaryGeneratedColumn()` int to BIGINT UNSIGNED — `synchronize` is
// off, so the migration is the source of truth) plus `createdAt` / `updatedAt` /
// `deletedAt`. `deletedAt` stays INERT — a payment is append-only, never
// soft-deleted (ADR-028).
//
// `order_id` is a plain BIGINT scalar with **no `@ManyToOne`**: `Payment` is its own
// aggregate root, not a child of `Order`, so a plain column + the `FK_PAYMENT_ORDER`
// foreign key (in the migration) is enough — the same shape `order_line.variant_id`
// uses for its opaque FK. `gateway_reference` is UNIQUE (each authorize mints a
// distinct reference); the UNIQUE constraint + the `order_id` index live in the
// migration. `status` is an ENUM column; `authorized_at` / `captured_at` are
// nullable timestamps (a payment is authorized-then-maybe-captured). SnakeNamingStrategy
// maps `orderId` → `order_id`, `gatewayReference` → `gateway_reference`, etc.
// (ADR-019); mysql2 returns non-PK BIGINTs as strings, so the mapper coerces
// `order_id` / `amount_minor` back with `Number(...)`.
@Entity('payment')
export class PaymentEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public orderId: number;

  @Column({ type: 'bigint' })
  public amountMinor: number;

  @Column({ type: 'char', length: 3 })
  public currency: string;

  @Column({ type: 'varchar', length: 64 })
  public method: string;

  @Column({ type: 'enum', enum: PaymentStatusEnum })
  public status: PaymentStatusEnum;

  @Column({ type: 'varchar', length: 255 })
  public gatewayReference: string;

  @Column({ type: 'timestamp', nullable: true })
  public authorizedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  public capturedAt: Date | null;

  // Set by Cancel Order on a captured payment to mark a refund is owed (a later
  // capability consumes it). The boolean default is declared explicitly even though
  // SnakeNamingStrategy maps `flaggedForRefund` → `flagged_for_refund`
  // (docs/adr/028-cart-order-payment-and-address-chain.md §6 — the column ships
  // ahead of its writer).
  @Column({ name: 'flagged_for_refund', type: 'boolean', default: false })
  public flaggedForRefund: boolean;
}
