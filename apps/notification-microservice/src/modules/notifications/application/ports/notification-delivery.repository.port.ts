import {
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';

import { NotificationDelivery } from '../../domain';

export const NOTIFICATION_DELIVERY_REPOSITORY = Symbol('NOTIFICATION_DELIVERY_REPOSITORY');

export interface INotificationDeliveryListFilter {
  status?: NotificationDeliveryStatusEnum;
  channel?: NotificationChannelEnum;
  eventReferenceType?: string;
  eventReferenceId?: string;
  recipientCustomerId?: string;
}

export interface INotificationDeliveryPageRequest {
  page: number;
  size: number;
}

export interface INotificationDeliveryPage {
  items: NotificationDelivery[];
  total: number;
  page: number;
  size: number;
}

export interface INotificationDeliveryRepositoryPort {
  save(delivery: NotificationDelivery): Promise<NotificationDelivery>;
  findById(id: number): Promise<NotificationDelivery | null>;
  findByDedupeKey(
    templateId: number,
    eventReferenceType: string,
    eventReferenceId: string,
    channel: NotificationChannelEnum,
    recipientCustomerId: string,
  ): Promise<NotificationDelivery | null>;
  list(
    filter: INotificationDeliveryListFilter,
    page: INotificationDeliveryPageRequest,
  ): Promise<INotificationDeliveryPage>;
  listRetryable(
    maxAttempts: number,
    limit: number,
    queuedStaleBefore: Date,
  ): Promise<NotificationDelivery[]>;
  deleteOlderThan(horizon: Date, limit: number): Promise<number>;
}
