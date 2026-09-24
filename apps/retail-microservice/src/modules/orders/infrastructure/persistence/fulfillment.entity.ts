import { Column, Entity, OneToMany, VersionColumn } from 'typeorm';

import { FulfillmentStatusEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

import { FulfillmentLineEntity } from './fulfillment-line.entity';

@Entity('fulfillment')
export class FulfillmentEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public orderId: number;

  @Column({ type: 'varchar', length: 64 })
  public stockLocationId: string;

  @Column({ type: 'enum', enum: FulfillmentStatusEnum, default: FulfillmentStatusEnum.PENDING })
  public status: FulfillmentStatusEnum;

  @Column({ type: 'varchar', length: 64, nullable: true })
  public trackingNumber: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  public carrier: string | null;

  @Column({ type: 'timestamp', nullable: true })
  public shippedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  public deliveredAt: Date | null;

  @VersionColumn()
  public version: number;

  @OneToMany(() => FulfillmentLineEntity, (line) => line.fulfillment)
  public lines: FulfillmentLineEntity[];
}
