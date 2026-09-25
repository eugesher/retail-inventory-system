import { NotificationDelivery } from '../../domain';
import { NotificationDeliveryStatusEnum } from '@retail-inventory-system/contracts';

export const QUEUED_STALE_AFTER_MS = 5 * 60 * 1_000;

export const staleQueuedHorizon = (now: Date): Date =>
  new Date(now.getTime() - QUEUED_STALE_AFTER_MS);

export const isOrphanedQueued = (delivery: NotificationDelivery, now: Date): boolean =>
  delivery.status === NotificationDeliveryStatusEnum.QUEUED &&
  delivery.createdAt !== null &&
  delivery.createdAt.getTime() < staleQueuedHorizon(now).getTime();
