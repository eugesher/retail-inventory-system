import { Column, Entity, PrimaryColumn } from 'typeorm';

import { AddressOwnerTypeEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

// `address.id` is a caller-assigned CHAR(36) UUID string PK (generated in-app by
// `Address.forOrder`), which diverges from `BaseEntity`'s auto-increment numeric
// `id`. A plain `extends BaseEntity` with `id: string` is a TS2416 type clash;
// re-typing the `BaseEntity` constructor to drop its `id` lets us declare a string
// PK cleanly while still inheriting `createdAt` / `updatedAt` / `deletedAt` from the
// prototype metadata. `deletedAt` stays INERT — an address is immutable, never
// soft-deleted (ADR-028). The same string-PK override `CartEntity` /
// `StockLocationEntity` use.
const AddressBaseEntity: abstract new () => Omit<BaseEntity, 'id'> = BaseEntity;

// The polymorphic address row (ADR-028 §5). `(owner_type, owner_id)` is the
// discriminator — an address belongs to a `customer` (a future address-book entry)
// or to an `order` (a place-time snapshot). This chain writes only `order` rows.
// `owner_id` is VARCHAR(36) so it holds either a customer's CHAR(36) UUID or an
// order's (short, stringified) numeric id. The composite `(owner_type, owner_id)`
// index lives in the migration. SnakeNamingStrategy maps `recipientName` →
// `recipient_name`, `postalCode` → `postal_code`, etc. (ADR-019).
@Entity('address')
export class AddressEntity extends AddressBaseEntity {
  @PrimaryColumn({ type: 'char', length: 36 })
  public id: string;

  @Column({ type: 'enum', enum: AddressOwnerTypeEnum })
  public ownerType: AddressOwnerTypeEnum;

  @Column({ type: 'varchar', length: 36 })
  public ownerId: string;

  @Column({ type: 'varchar', length: 255 })
  public recipientName: string;

  @Column({ type: 'varchar', length: 255 })
  public line1: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  public line2: string | null;

  @Column({ type: 'varchar', length: 128 })
  public city: string;

  @Column({ type: 'varchar', length: 128 })
  public region: string;

  @Column({ type: 'varchar', length: 32 })
  public postalCode: string;

  @Column({ type: 'char', length: 2 })
  public country: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  public phone: string | null;
}
