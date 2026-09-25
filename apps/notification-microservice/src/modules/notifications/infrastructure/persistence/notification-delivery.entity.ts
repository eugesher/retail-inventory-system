import { Column, Entity } from 'typeorm';

import {
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

@Entity('notification_delivery')
export class NotificationDeliveryEntity extends BaseEntity {
  @Column({ type: 'bigint', unsigned: true })
  public templateId: number;

  @Column({ type: 'varchar', length: 64, nullable: true })
  public recipientCustomerId: string | null;

  @Column({ type: 'varchar', length: 255 })
  public recipientAddress: string;

  @Column({ type: 'enum', enum: NotificationChannelEnum })
  public channel: NotificationChannelEnum;

  @Column({ type: 'varchar', length: 32 })
  public eventReferenceType: string;

  @Column({ type: 'varchar', length: 64 })
  public eventReferenceId: string;

  @Column({
    type: 'enum',
    enum: NotificationDeliveryStatusEnum,
    default: NotificationDeliveryStatusEnum.QUEUED,
  })
  public status: NotificationDeliveryStatusEnum;

  @Column({ type: 'int', default: 0 })
  public attemptCount: number;

  @Column({ type: 'timestamp', nullable: true })
  public lastAttemptAt: Date | null;

  @Column({ type: 'text', nullable: true })
  public failureReason: string | null;

  @Column({ type: 'text', nullable: true })
  public renderedSubject: string | null;

  @Column({ type: 'text' })
  public renderedBody: string;

  @Column({ type: 'varchar', length: 64 })
  public correlationId: string;
}
