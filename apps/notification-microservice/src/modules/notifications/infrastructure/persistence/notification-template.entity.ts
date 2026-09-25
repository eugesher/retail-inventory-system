import { Column, Entity } from 'typeorm';

import { NotificationChannelEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

@Entity('notification_template')
export class NotificationTemplateEntity extends BaseEntity {
  @Column({ type: 'varchar', length: 64 })
  public eventType: string;

  @Column({ type: 'enum', enum: NotificationChannelEnum })
  public channel: NotificationChannelEnum;

  @Column({ type: 'varchar', length: 10 })
  public locale: string;

  @Column({ type: 'text', nullable: true })
  public subject: string | null;

  @Column({ type: 'text' })
  public body: string;

  @Column({ type: 'int' })
  public version: number;

  @Column({ type: 'boolean', default: true })
  public active: boolean;
}
