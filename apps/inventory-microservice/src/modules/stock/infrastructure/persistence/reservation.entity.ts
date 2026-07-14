import { Column, Entity, PrimaryColumn, VersionColumn } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';

import { ReservationStatusEnum } from '../../domain';

// `reservation.id` is a caller-assigned CHAR(36) UUID string PK (generated in-app
// by `Reservation.create`), which diverges from `BaseEntity`'s auto-increment
// numeric `id`. A plain `extends BaseEntity` with `id: string` is a TS2416 type
// clash (`string` is not assignable to the inherited `number`); re-typing the
// `BaseEntity` constructor to drop its `id` lets us declare a string PK cleanly
// while still inheriting `createdAt` / `updatedAt` / `deletedAt`. `deletedAt`
// stays INERT — a reservation's lifecycle is its `status`, never a soft-delete
// timestamp (the catalog / pricing / stock convention; ADR-030). The same
// string-PK override `CartEntity` / `AddressEntity` / `StockLocationEntity` use.
const ReservationBaseEntity: abstract new () => Omit<BaseEntity, 'id'> = BaseEntity;

// **`variant_id` and `cart_id` are plain scalars with NO `@ManyToOne`.** Inventory may not import
// the catalog or retail entities, so the relations cannot be expressed here — **the FKs exist only
// in the migration**. A reader who trusts the entity will conclude there is no referential
// integrity; there is, and TypeORM simply cannot see it.
@Entity('reservation')
export class ReservationEntity extends ReservationBaseEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  public id: string;

  @Column({ type: 'bigint', unsigned: true })
  public variantId: number;

  @Column({ type: 'varchar', length: 64 })
  public stockLocationId: string;

  @Column({ type: 'int' })
  public quantity: number;

  @Column({ type: 'char', length: 36 })
  public cartId: string;

  @Column({ type: 'timestamp' })
  public expiresAt: Date;

  @Column({ type: 'enum', enum: ReservationStatusEnum, default: ReservationStatusEnum.ACTIVE })
  public status: ReservationStatusEnum;

  // The OCC token. TypeORM increments the persisted value on every managed save — the domain's own
  // in-memory bump exists so the model stays testable without a database, not to drive this column.
  @VersionColumn()
  public version: number;
}
