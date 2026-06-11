import { Column, Entity, OneToMany, PrimaryColumn, VersionColumn } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';
import { CartStatusEnum } from '@retail-inventory-system/contracts';

import { CartLineEntity } from './cart-line.entity';

// `cart.id` is a caller-assigned CHAR(36) UUID string PK (generated in-app by
// `Cart.create`), which diverges from `BaseEntity`'s auto-increment numeric `id`.
// A plain `extends BaseEntity` with `id: string` is a TS2416 type clash (`string`
// is not assignable to the inherited `number`); re-typing the `BaseEntity`
// constructor to drop its `id` lets us declare a string PK cleanly while still
// inheriting `createdAt` / `updatedAt` / `deletedAt` from the prototype metadata.
// `deletedAt` stays INERT — a cart is purged by status (abandoned/converted),
// never soft-deleted (ADR-028). The same string-PK override `StockLocationEntity`
// uses.
const CartBaseEntity: abstract new () => Omit<BaseEntity, 'id'> = BaseEntity;

// SnakeNamingStrategy maps the camelCase fields to snake_case columns
// (`customerId` → `customer_id`, `expiresAt` → `expires_at`); no
// `@Column({ name })` overrides are needed (ADR-019).
@Entity('cart')
export class CartEntity extends CartBaseEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  public id: string;

  // The gateway customer UUID (ADR-024), or NULL for a guest cart. The FK
  // (`ON DELETE SET NULL`) lives in the migration so deleting a customer leaves
  // a customerless cart rather than cascading the cart away.
  @Column({ type: 'char', length: 36, nullable: true })
  public customerId: string | null;

  @Column({ type: 'char', length: 3 })
  public currency: string;

  @Column({ type: 'enum', enum: CartStatusEnum, default: CartStatusEnum.ACTIVE })
  public status: CartStatusEnum;

  @Column({ type: 'timestamp', nullable: true })
  public expiresAt: Date | null;

  // Optimistic-concurrency token. TypeORM owns the persisted value via
  // `@VersionColumn` (incremented on each managed save); the guard it enables is
  // a later concurrency-hardening capability. Shipping the column now keeps that
  // retrofit non-destructive — no future `ALTER TABLE` on a populated table
  // (ADR-028 §6, the same reasoning ADR-027 used for `stock_level.version`).
  @VersionColumn()
  public version: number;

  // No TypeORM `cascade`: the repository drives line persistence explicitly (root
  // save → orphan reconciliation → line save), so a removed line is deleted, not
  // left behind (TypeORM cascade does not include `remove`) and a cascade option
  // would never fire. `onDelete: 'CASCADE'` (the DB-level FK) means deleting a cart
  // drops its lines.
  @OneToMany(() => CartLineEntity, (line) => line.cart)
  public lines: CartLineEntity[];
}
