import { INotificationDeliveryFailedEvent } from '@retail-inventory-system/contracts';

export const NOTIFICATION_EVENTS_PUBLISHER = Symbol('NOTIFICATION_EVENTS_PUBLISHER');

// The notification context's own outbound-event seam (ADR-020 / ADR-033). The retry use
// cases depend on this port; the sole `ClientProxy` holder
// (`NotificationRabbitmqPublisher`) lives in `infrastructure/messaging/` and emits onto
// the service's own `notification_events` queue. Keeping the publish behind a port lets
// the use cases be unit-tested without RabbitMQ (the `IStockEventsPublisherPort` /
// `IReturnEventsPublisherPort` precedent).
//
// One method today — `publishDeliveryFailed` for the cap-exhausted alerting event. It is
// a best-effort post-state emit: a publish failure is warn-logged and swallowed by the
// caller (the delivery is already persisted `failed`; the alert is fire-and-forget,
// ADR-020).
export interface INotificationEventsPublisherPort {
  publishDeliveryFailed(event: INotificationDeliveryFailedEvent): Promise<void>;
}
