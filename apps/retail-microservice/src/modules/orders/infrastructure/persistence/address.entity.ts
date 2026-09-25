import { Column, Entity, PrimaryColumn } from 'typeorm';

import { AddressOwnerTypeEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

const AddressBaseEntity: abstract new () => Omit<BaseEntity, 'id'> = BaseEntity;

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
