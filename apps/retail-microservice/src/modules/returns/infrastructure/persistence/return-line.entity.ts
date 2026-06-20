import { Column, Entity, JoinColumn, ManyToOne } from 'typeorm';

import { ReturnDispositionEnum, ReturnLineConditionEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

import { ReturnRequestEntity } from './return-request.entity';

// One line of a return request — which `OrderLine` quantity is coming back. The owning
// request is mapped through the `@ManyToOne` relation alone (its `@JoinColumn` is the
// `return_request_id` FK) — there is no separate `returnRequestId` scalar column. A
// child entity does not carry its parent's id as a scalar in the persistence mapping
// (the relation does), the same shape `fulfillment_line` / `order_line` use
// (ADR-028/031/032).
//
// `order_line_id` is mapped as a plain BIGINT scalar with NO `@ManyToOne` relation —
// the line points back at the placed order's line through the
// `FK_RETURN_LINE_ORDER_LINE` foreign key (in the migration), not an owned relation
// (the `fulfillment_line.order_line_id` opaque-FK precedent).
//
// `condition` / `disposition` are nullable ENUMs and `line_refund_amount_minor` a
// nullable BIGINT — all three are `NULL` from Open until inspection records them. The
// minor-units refund amount is BIGINT so a large refund never overflows; mysql2 returns
// non-PK BIGINTs as strings, so the mapper coerces back with `Number(...)` preserving
// null.
//
// `BaseEntity` supplies the BIGINT `id` (the migration widens the
// `@PrimaryGeneratedColumn()` int to BIGINT) plus `createdAt` / `updatedAt` /
// `deletedAt`. `deletedAt` stays INERT — a return line is append-only.
@Entity('return_line')
export class ReturnLineEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public orderLineId: number;

  @Column({ type: 'int' })
  public quantity: number;

  @Column({ type: 'enum', enum: ReturnLineConditionEnum, nullable: true })
  public condition: ReturnLineConditionEnum | null;

  @Column({ type: 'enum', enum: ReturnDispositionEnum, nullable: true })
  public disposition: ReturnDispositionEnum | null;

  @Column({ type: 'bigint', unsigned: true, nullable: true })
  public lineRefundAmountMinor: number | null;

  // `ON DELETE CASCADE`: a line cannot outlive its request (the parent is never
  // hard-deleted, so this is a safety net). The `@JoinColumn` is the
  // `return_request_id` FK column — the parent id lives only through this relation.
  @ManyToOne(() => ReturnRequestEntity, (returnRequest) => returnRequest.lines, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({ name: 'return_request_id' })
  public returnRequest: ReturnRequestEntity;
}
