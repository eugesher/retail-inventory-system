import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';

import { FulfillmentEntity } from './fulfillment.entity';

// One line of a fulfillment — which `OrderLine` quantity is in this shipment. The
// owning fulfillment is mapped through the `@ManyToOne` relation alone (its
// `@JoinColumn` is the `fulfillment_id` FK) — there is no separate `fulfillmentId`
// scalar column. A child entity does not carry its parent's id as a scalar in the
// persistence mapping (the relation does), the same shape `order_line` /
// `cart_line` use (ADR-028 / ADR-031).
//
// `order_line_id` is mapped as a plain BIGINT scalar with NO `@ManyToOne` relation —
// the line points back at the placed order's line through the `FK_FULFILLMENT_LINE_ORDER_LINE`
// foreign key (in the migration), not an owned relation (the `order_line.variant_id`
// opaque-FK precedent).
//
// `BaseEntity` supplies the BIGINT `id` (the migration widens the
// `@PrimaryGeneratedColumn()` int to BIGINT) plus `createdAt` / `updatedAt` /
// `deletedAt`. `deletedAt` stays INERT — a fulfillment line is append-only.
@Entity('fulfillment_line')
export class FulfillmentLineEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public orderLineId: number;

  @Column({ type: 'int' })
  public quantity: number;

  // `ON DELETE CASCADE`: a line cannot outlive its fulfillment (the parent is never
  // hard-deleted, so this is a safety net). The `@JoinColumn` is the `fulfillment_id`
  // FK column — the parent id lives only through this relation.
  @ManyToOne(() => FulfillmentEntity, (fulfillment) => fulfillment.lines, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'fulfillment_id' })
  public fulfillment: FulfillmentEntity;
}
