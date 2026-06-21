import { ICorrelationPayload } from '../microservices';

// The two downstream-receipt outcomes a provider webhook can report against a `sent`
// delivery. They line up value-for-value with the terminal `NotificationDeliveryStatusEnum`
// receipt members (`DELIVERED` / `BOUNCED`) — a narrow union (rather than the whole status
// enum) so the type itself forbids reporting a non-receipt state like `queued` / `sent`
// as an "outcome" (the `ReservationReleaseReason` union precedent).
export type NotificationDeliveryOutcome = 'delivered' | 'bounced';

// Wire-format command payload for `notification.delivery.record-outcome` (API Gateway →
// Notification). Carries a `correlationId` for log/trace correlation.
//
// The seam a real ESP (email service provider) delivery webhook would drive: flip a
// `sent` delivery to `delivered` (a delivery receipt) or `bounced` (a bounce notice).
// `failureReason` carries the bounce detail (ignored for a `delivered` outcome). A
// non-`sent` source row is `NOTIFICATION_DELIVERY_INVALID_STATUS_TRANSITION` → 409; an
// unknown `deliveryId` is `NOTIFICATION_DELIVERY_NOT_FOUND` → 404.
//
// The webhook ingestion itself (HTTP endpoint, ESP signature verification, provider
// payload mapping) is out of scope this capability — this RPC is the internal sketch the
// bridge would call (ADR-033).
export interface INotificationDeliveryRecordOutcomePayload extends ICorrelationPayload {
  deliveryId: number;
  outcome: NotificationDeliveryOutcome;
  failureReason?: string;
}
