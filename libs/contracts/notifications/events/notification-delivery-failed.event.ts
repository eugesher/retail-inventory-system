import { ICorrelationPayload } from '../../microservices';

// Wire-format shape for the `notifications.delivery.failed` event, emitted by the
// notification microservice when a `NotificationDelivery` exhausts its
// `MAX_DELIVERY_ATTEMPTS` budget and remains `failed` after a (manual or scheduled)
// retry. Framework-free — a domain object is never serialized across services
// (ADR-011); the retry use case maps the failed delivery onto this interface before
// emitting.
//
// It rides the notification service's own `notification_events` queue as a **reserved
// surface** (no consumer today, ADR-033) — the downstream-alerting seam a future ops
// alert / dead-letter capability will bind. The payload is a thin header: `deliveryId`
// resolves the full audit row, `eventReferenceType` / `eventReferenceId` link it back to
// the originating business event (`order` / `return-request` / `stock-low` /
// `fulfillment` / `refund` + its id), and `failureReason` carries the last NOTIFIER
// rejection so an alert can be triaged without a second read. `eventVersion` is pinned to
// `'v1'`; a breaking change ships `'v2'`. `occurredAt` is an ISO-8601 string.
export interface INotificationDeliveryFailedEvent extends ICorrelationPayload {
  deliveryId: number;
  eventReferenceType: string;
  eventReferenceId: string;
  failureReason: string;
  eventVersion: 'v1';
  occurredAt: string;
}
