import { Column, Entity } from 'typeorm';

import {
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

// The queryable audit trail of one outgoing notification
// (docs/adr/033-notification-templates-deliveries-and-render-dispatch.md). It keeps
// `BaseEntity`'s generated numeric PK (the migration widens the
// `@PrimaryGeneratedColumn()` int to BIGINT UNSIGNED) plus `createdAt` / `updatedAt` /
// `deletedAt`. `deletedAt` stays **INERT**: a delivery row is live-ephemeral and never
// soft-deleted (a `RETENTION_DELIVERY_DAYS` purge is a deferred future capability).
//
// `template_id` is a plain BIGINT scalar — the `FK_NOTIFICATION_DELIVERY_TEMPLATE`
// foreign key (`→ notification_template(id)`, `ON DELETE RESTRICT` so deliveries outlive
// template-edit churn) lives in the migration; no `@ManyToOne` (a delivery is its own
// aggregate root, the `refund.payment_id` / `fulfillment.order_id` precedent).
// `recipient_customer_id` is a plain nullable scalar with NO FK — it is null for
// system/ops notifications, and the column also drives the dedupe generated column.
//
// **The `delivery_dedupe_key` STORED generated column is deliberately NOT mapped here**
// — it is a DB-internal idempotency backstop (the ADR-026 `open_scope_key` precedent).
// An INSERT that omits it lets MySQL compute it from `(event_reference_type,
// event_reference_id, channel, recipient_customer_id)` when `recipient_customer_id` is
// non-null; the UNIQUE index over it rejects a second customer-facing delivery for the
// same event. `synchronize` is off, so the column existing only in the migration is
// fine.
//
// SnakeNamingStrategy maps the camelCase fields to snake_case columns (ADR-019); the FK
// + the three indexes + the dedupe column/UNIQUE live only in the migration.
@Entity('notification_delivery')
export class NotificationDeliveryEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public templateId: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  public recipientCustomerId: string | null;

  @Column({ type: 'varchar', length: 255 })
  public recipientAddress: string;

  @Column({ type: 'enum', enum: NotificationChannelEnum })
  public channel: NotificationChannelEnum;

  @Column({ type: 'varchar', length: 32 })
  public eventReferenceType: string;

  @Column({ type: 'varchar', length: 64 })
  public eventReferenceId: string;

  @Column({
    type: 'enum',
    enum: NotificationDeliveryStatusEnum,
    default: NotificationDeliveryStatusEnum.QUEUED,
  })
  public status: NotificationDeliveryStatusEnum;

  @Column({ type: 'int', default: 0 })
  public attemptCount: number;

  @Column({ type: 'timestamp', nullable: true })
  public lastAttemptAt: Date | null;

  @Column({ type: 'text', nullable: true })
  public failureReason: string | null;

  @Column({ type: 'text', nullable: true })
  public renderedSubject: string | null;

  @Column({ type: 'text' })
  public renderedBody: string;

  @Column({ type: 'varchar', length: 64 })
  public correlationId: string;
}
