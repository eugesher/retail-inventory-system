import { Column, Entity } from 'typeorm';

import { RefundStatusEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

@Entity('refund')
export class RefundEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public orderId: number;

  @Column({ type: 'bigint', unsigned: true })
  public paymentId: number;

  @Column({ type: 'bigint' })
  public amountMinor: number;

  @Column({ type: 'char', length: 3 })
  public currency: string;

  @Column({ type: 'enum', enum: RefundStatusEnum })
  public status: RefundStatusEnum;

  @Column({ type: 'varchar', length: 255 })
  public reason: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  public gatewayReference: string | null;

  @Column({ type: 'timestamp', nullable: true })
  public issuedAt: Date | null;
}
