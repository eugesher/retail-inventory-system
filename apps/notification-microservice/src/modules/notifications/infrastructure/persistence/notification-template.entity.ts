import { Column, Entity } from 'typeorm';

import { NotificationChannelEnum } from '@retail-inventory-system/contracts';
import { BaseEntity } from '@retail-inventory-system/database';

// One versioned entry in the per `(event_type, channel, locale)` notification-template
// registry (docs/adr/033-notification-templates-deliveries-and-render-dispatch.md). It
// keeps `BaseEntity`'s generated numeric PK (the migration widens the
// `@PrimaryGeneratedColumn()` int to BIGINT UNSIGNED — `synchronize` is off, so the
// migration is the source of truth) plus `createdAt` / `updatedAt` / `deletedAt`.
// `deletedAt` stays **INERT**: a template is soft-deleted via the `active` flag, never
// a timestamp (the `StockLocation` / `Category` convention).
//
// **`version` is a plain INT business version, NOT a `@VersionColumn` OCC token.** An
// edit appends a brand-new row at `version + 1` (the old row retained for audit /
// rollback); the value identifies *which* edit this row is and is part of the natural
// key. The registry ships no optimistic-lock column — last-writer-wins is acceptable
// for a staff-authored registry (the catalog stance, ADR-025).
//
// SnakeNamingStrategy maps `eventType` → `event_type`, etc. (ADR-019). The UNIQUE
// `(event_type, channel, locale, version)` and the `(event_type, channel, locale,
// active)` "find latest active" index live only in the migration (the source of truth
// with `synchronize` off).
@Entity('notification_template')
export class NotificationTemplateEntity extends BaseEntity {
  @Column({ type: 'varchar', length: 64 })
  public eventType: string;

  @Column({ type: 'enum', enum: NotificationChannelEnum })
  public channel: NotificationChannelEnum;

  @Column({ type: 'varchar', length: 10 })
  public locale: string;

  // Nullable: sms/push templates carry no subject line (the channel-specific rule the
  // domain enforces).
  @Column({ type: 'text', nullable: true })
  public subject: string | null;

  @Column({ type: 'text' })
  public body: string;

  @Column({ type: 'int' })
  public version: number;

  @Column({ type: 'boolean', default: true })
  public active: boolean;
}
