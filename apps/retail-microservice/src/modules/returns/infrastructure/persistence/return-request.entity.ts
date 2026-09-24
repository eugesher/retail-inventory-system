import { Column, Entity, OneToMany, VersionColumn } from 'typeorm';

import { ReturnReasonCategoryEnum, ReturnStatusEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

import { ReturnLineEntity } from './return-line.entity';

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

  @VersionColumn()
  public version: number;

  @OneToMany(() => ReturnLineEntity, (line) => line.returnRequest)
  public lines: ReturnLineEntity[];
}
