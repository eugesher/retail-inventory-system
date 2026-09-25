import { NotificationChannelEnum } from '@retail-inventory-system/contracts';

import { NotificationTemplate } from '../../domain';

export const NOTIFICATION_TEMPLATE_REPOSITORY = Symbol('NOTIFICATION_TEMPLATE_REPOSITORY');

export interface INotificationTemplateListFilter {
  eventType?: string;
  channel?: NotificationChannelEnum;
  locale?: string;
  activeOnly?: boolean;
}

export interface INotificationTemplateRepositoryPort {
  save(template: NotificationTemplate): Promise<NotificationTemplate>;
  findById(id: number): Promise<NotificationTemplate | null>;
  findLatestActive(
    eventType: string,
    channel: NotificationChannelEnum,
    locale: string,
  ): Promise<NotificationTemplate | null>;
  findByNaturalKey(
    eventType: string,
    channel: NotificationChannelEnum,
    locale: string,
    version: number,
  ): Promise<NotificationTemplate | null>;
  maxVersion(
    eventType: string,
    channel: NotificationChannelEnum,
    locale: string,
  ): Promise<number | null>;
  list(filter: INotificationTemplateListFilter): Promise<NotificationTemplate[]>;
}
