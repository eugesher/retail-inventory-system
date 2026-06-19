import { Column, Entity } from 'typeorm';

import { RefundStatusEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

// The refund row. It keeps `BaseEntity`'s generated numeric PK (the migration widens
// the `@PrimaryGeneratedColumn()` int to BIGINT UNSIGNED — `synchronize` is off, so the
// migration is the source of truth) plus `createdAt` / `updatedAt` / `deletedAt`.
// `deletedAt` stays INERT — a refund is append-only, never soft-deleted (a gateway
// decline is recorded as `status='failed'`, ADR-032).
//
// `order_id` and `payment_id` are plain BIGINT scalars with **no `@ManyToOne`**:
// `Refund` is its own aggregate root, not a child of `Order` or `Payment`, so plain
// columns + the `FK_REFUND_ORDER` / `FK_REFUND_PAYMENT` foreign keys (in the migration)
// are enough — the same shape `payment.order_id` uses for its opaque FK. `status` is an
// ENUM column; `gateway_reference` / `issued_at` are nullable (a refund is `pending`
// before the gateway answers). SnakeNamingStrategy maps `orderId` → `order_id`,
// `paymentId` → `payment_id`, `gatewayReference` → `gateway_reference`, etc. (ADR-019);
// mysql2 returns non-PK BIGINTs as strings, so the mapper coerces `order_id` /
// `payment_id` / `amount_minor` back with `Number(...)`.
@Entity('refund')
export class RefundEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public orderId: number;

  @Column({ type: 'bigint', unsigned: true })
  public paymentId: number;

  @Column({ type: 'bigint' })
  public amountMinor: number;

  @Column({ type: 'char', length: 3 })
  public currency: string;

  @Column({ type: 'enum', enum: RefundStatusEnum })
  public status: RefundStatusEnum;

  @Column({ type: 'varchar', length: 255 })
  public reason: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  public gatewayReference: string | null;

  @Column({ type: 'timestamp', nullable: true })
  public issuedAt: Date | null;
}
