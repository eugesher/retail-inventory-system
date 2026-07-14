import { ICorrelationPayload } from '../microservices';

// RPC payload for `notification.delivery.retry` — the operator manual-retry of one `failed`
// delivery (ADR-033).
export interface INotificationDeliveryRetryPayload extends ICorrelationPayload {
  deliveryId: number;
}
