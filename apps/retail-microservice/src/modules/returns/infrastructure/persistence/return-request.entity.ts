import { Column, Entity, OneToMany, VersionColumn } from 'typeorm';

import { ReturnReasonCategoryEnum, ReturnStatusEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

import { ReturnLineEntity } from './return-line.entity';

// The RMA (Return Merchandise Authorization) row — the buyer's request to send a
// delivered/shipped order's goods back, driven through a six-state lifecycle
// (docs/adr/032-returns-and-refunds-rma-lifecycle-and-restock.md). It keeps
// `BaseEntity`'s generated numeric PK (the migration widens the
// `@PrimaryGeneratedColumn()` int to BIGINT UNSIGNED — `synchronize` is off, so the
// migration is the source of truth) plus `createdAt` / `updatedAt` / `deletedAt`.
// `deletedAt` stays INERT — a return request is append-only; rejection/closure are
// `status` flips, never a soft-delete (ADR-032).
//
// `order_id` is a plain BIGINT scalar with **no `@ManyToOne`**: a `ReturnRequest` is
// its own aggregate root, not a child of `Order`, so a plain column + the
// `FK_RETURN_REQUEST_ORDER` foreign key (in the migration) is enough — the same shape
// `fulfillment.order_id` / `payment.order_id` use. `customer_id` is the gateway
// customer's CHAR(36) UUID (the buyer, copied from the order) under
// `FK_RETURN_REQUEST_CUSTOMER` — mirroring `order.customer_id`'s reference to the
// gateway `customer` aggregate (ADR-024); the returns domain never imports the auth
// module, so it is a plain scalar. `rma_number` is the human-facing
// `RMA-<year>-<pad8(id)>` finalized post-insert (the `order_number` idiom); it is
// nullable in the schema only because it is written in a second UPDATE after the id is
// known (MySQL allows multiple NULLs under a UNIQUE index).
//
// SnakeNamingStrategy maps the camelCase fields to snake_case columns
// (`rmaNumber` → `rma_number`, `reasonCategory` → `reason_category`, etc.); no
// `@Column({ name })` overrides are needed (ADR-019). The FKs, the UNIQUE `rma_number`,
// and the two `(…, requested_at)` indexes live in the migration.
@Entity('return_request')
export class ReturnRequestEntity extends BaseEntity {
  @Column({ type: 'varchar', length: 20, nullable: true })
  public rmaNumber: string | null;

  @Column({ type: 'bigint', unsigned: true })
  public orderId: number;

  @Column({ type: 'char', length: 36 })
  public customerId: string;

  @Column({ type: 'enum', enum: ReturnStatusEnum, default: ReturnStatusEnum.REQUESTED })
  public status: ReturnStatusEnum;

  @Column({ type: 'enum', enum: ReturnReasonCategoryEnum })
  public reasonCategory: ReturnReasonCategoryEnum;

  @Column({ type: 'text', nullable: true })
  public notes: string | null;

  @Column({ type: 'timestamp' })
  public requestedAt: Date;

  @Column({ type: 'timestamp', nullable: true })
  public authorizedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  public closedAt: Date | null;

  // Optimistic-concurrency token. TypeORM owns the persisted value via
  // `@VersionColumn` (incremented on each managed save); the guard it enables is a
  // later concurrency-hardening capability. Shipping the column now keeps that
  // retrofit non-destructive (the `order.version` / `fulfillment.version` precedent).
  @VersionColumn()
  public version: number;

  // No TypeORM `cascade`: the repository drives line persistence explicitly inside
  // one transaction (root save → line save). The DB-level FK is `ON DELETE CASCADE`
  // (a return line cannot outlive its request) — but the request itself is never
  // hard-deleted, so the cascade is a safety net, not a routine path.
  @OneToMany(() => ReturnLineEntity, (line) => line.returnRequest)
  public lines: ReturnLineEntity[];
}
