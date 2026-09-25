import { Column, Entity } from 'typeorm';

import { PaymentStatusEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

@Entity('payment')
export class PaymentEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public orderId: number;

  @Column({ type: 'bigint' })
  public amountMinor: number;

  @Column({ type: 'char', length: 3 })
  public currency: string;

  @Column({ type: 'varchar', length: 64 })
  public method: string;

  @Column({ type: 'enum', enum: PaymentStatusEnum })
  public status: PaymentStatusEnum;

  @Column({ type: 'varchar', length: 255 })
  public gatewayReference: string;

  @Column({ type: 'timestamp', nullable: true })
  public authorizedAt: Date | null;

  @Column({ type: 'timestamp', nullable: true })
  public capturedAt: Date | null;

  @Column({ name: 'flagged_for_refund', type: 'boolean', default: false })
  public flaggedForRefund: boolean;

  @Column({ name: 'refunded_amount_minor', type: 'bigint', unsigned: true, default: 0 })
  public refundedAmountMinor: number;
}
