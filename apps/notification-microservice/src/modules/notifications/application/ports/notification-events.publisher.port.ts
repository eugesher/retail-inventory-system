import { INotificationDeliveryFailedEvent } from '@retail-inventory-system/contracts';

export const NOTIFICATION_EVENTS_PUBLISHER = Symbol('NOTIFICATION_EVENTS_PUBLISHER');

export interface INotificationEventsPublisherPort {
  publishDeliveryFailed(event: INotificationDeliveryFailedEvent): Promise<void>;
}
