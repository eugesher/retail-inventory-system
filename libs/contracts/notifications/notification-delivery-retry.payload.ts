import { ICorrelationPayload } from '../microservices';

// RPC payload for `notification.delivery.retry` (Gateway → Notification) — the operator
// manual-retry of one `failed` delivery (ADR-033). The gateway folds the resolved
// `deliveryId` (from the manual-retry route, a later capability) and `correlationId` into
// this shape; the use case re-dispatches the already-rendered content via `NOTIFIER`,
// forcing past the backoff gate the scheduled sweeper honors. Extends `ICorrelationPayload`
// (ADR-001 — every outbound RMQ payload carries `correlationId`).
export interface INotificationDeliveryRetryPayload extends ICorrelationPayload {
  deliveryId: number;
}
