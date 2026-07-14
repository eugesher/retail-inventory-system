import { ICorrelationPayload } from '../../microservices';

// `notifications.delivery.failed` — a **reserved surface** (README §2). Not dead code: it is the
// seam an ops-alert or dead-letter consumer binds.
//
// **It fires only at the end of the road** — when a delivery has exhausted `MAX_DELIVERY_ATTEMPTS`
// and stays `failed`. An individual failed attempt raises nothing, so a consumer counting these
// is counting abandoned notifications, not failures.
//
// `eventReferenceType` / `eventReferenceId` link back to the originating business event (`order`,
// `return-request`, `stock-low`, `fulfillment`, `refund`), and `failureReason` carries the last
// `NOTIFIER` rejection — enough to triage without a second read.
export interface INotificationDeliveryFailedEvent extends ICorrelationPayload {
  deliveryId: number;
  eventReferenceType: string;
  eventReferenceId: string;
  failureReason: string;
  eventVersion: 'v1';
  occurredAt: string;
}
