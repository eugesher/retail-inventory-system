import { Column, Entity, PrimaryColumn, VersionColumn } from 'typeorm';

import { BaseEntity } from '@retail-inventory-system/database';

import { ReservationStatusEnum } from '../../domain';

const ReservationBaseEntity: abstract new () => Omit<BaseEntity, 'id'> = BaseEntity;

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

  @VersionColumn()
  public version: number;
}
