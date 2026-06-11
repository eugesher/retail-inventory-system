import { Column, Entity, OneToMany, VersionColumn } from 'typeorm';

import {
  OrderFulfillmentStatusEnum,
  OrderPaymentStatusEnum,
  OrderStatusEnum,
} from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

import { OrderLineEntity } from './order-line.entity';

// The immutable placed-order row. It keeps `BaseEntity`'s generated numeric PK
// (the migration widens the `@PrimaryGeneratedColumn()` int to BIGINT UNSIGNED —
// `synchronize` is off, so the migration is the source of truth) plus
// `createdAt` / `updatedAt` / `deletedAt`. `deletedAt` stays INERT — an order is
// append-only, never soft-deleted (ADR-028).
//
// SnakeNamingStrategy maps the camelCase fields to snake_case columns
// (`orderNumber` → `order_number`, `paymentStatus` → `payment_status`, etc.); no
// `@Column({ name })` overrides are needed (ADR-019). The three status fields are
// orthogonal ENUM columns (ADR-028 §2); the five money totals are BIGINT minor
// units; `billing_address_id` / `shipping_address_id` are plain CHAR(36) pointers
// to snapshotted `address` rows (a plain column + FK is enough — they are pointers,
// not an owned relation, so no `@ManyToOne`). The `order_number` UNIQUE,
// `source_cart_id` / `customer_id` FKs, and address FKs all live in the migration.
@Entity('order')
export class OrderEntity extends BaseEntity {
  @Column({ type: 'varchar', length: 20 })
  public orderNumber: string;

  // The gateway customer UUID (ADR-024), or NULL once a customer is deleted out
  // from under an order — the FK (`ON DELETE SET NULL`, in the migration) leaves an
  // order tombstone rather than cascading the order away.
  @Column({ type: 'char', length: 36, nullable: true })
  public customerId: string | null;

  @Column({ type: 'char', length: 3 })
  public currency: string;

  @Column({ type: 'enum', enum: OrderStatusEnum, default: OrderStatusEnum.PENDING })
  public status: OrderStatusEnum;

  @Column({
    type: 'enum',
    enum: OrderPaymentStatusEnum,
    default: OrderPaymentStatusEnum.NONE,
  })
  public paymentStatus: OrderPaymentStatusEnum;

  @Column({
    type: 'enum',
    enum: OrderFulfillmentStatusEnum,
    default: OrderFulfillmentStatusEnum.UNFULFILLED,
  })
  public fulfillmentStatus: OrderFulfillmentStatusEnum;

  // Minor units (integer cents). BIGINT so a large order total never overflows;
  // mysql2 returns non-PK BIGINTs as strings, so the mapper coerces back with
  // `Number(...)`. Tax/discount/shipping default 0 in this capability.
  @Column({ type: 'bigint' })
  public subtotalMinor: number;

  @Column({ type: 'bigint', default: 0 })
  public taxTotalMinor: number;

  @Column({ type: 'bigint', default: 0 })
  public discountTotalMinor: number;

  @Column({ type: 'bigint', default: 0 })
  public shippingTotalMinor: number;

  @Column({ type: 'bigint' })
  public grandTotalMinor: number;

  @Column({ type: 'char', length: 36, nullable: true })
  public billingAddressId: string | null;

  @Column({ type: 'char', length: 36, nullable: true })
  public shippingAddressId: string | null;

  // The cart this order converted from — the link that makes repeat-place
  // idempotent (re-placing a converted cart returns this order). FK
  // (`ON DELETE SET NULL`, in the migration) so purging a cart leaves the order.
  @Column({ type: 'char', length: 36, nullable: true })
  public sourceCartId: string | null;

  @Column({ type: 'timestamp', nullable: true })
  public placedAt: Date | null;

  // Optimistic-concurrency token. TypeORM owns the persisted value via
  // `@VersionColumn` (incremented on each managed save); the guard it enables is a
  // later concurrency-hardening capability. Shipping the column now keeps that
  // retrofit non-destructive (ADR-028 §6).
  @VersionColumn()
  public version: number;

  // No TypeORM `cascade`: the repository drives line persistence explicitly inside
  // one transaction (root save → line save), so a cascade option would never fire.
  // `onDelete: 'RESTRICT'` (the DB-level FK) means an order's lines are never
  // orphaned — orders are append-only.
  @OneToMany(() => OrderLineEntity, (line) => line.order)
  public lines: OrderLineEntity[];
}
