import { ICorrelationPayload } from '../microservices';

// Wire-format query payload for `notification.delivery.get` (API Gateway →
// Notification). Carries a `correlationId` for log/trace correlation.
//
// Loads one full delivery row by id — including the materialized `renderedBody`
// (which the paged `list` carries too, but this is the single-row drill-down). An
// unknown `id` surfaces `NOTIFICATION_DELIVERY_NOT_FOUND` → 404 (ADR-033).
export interface INotificationDeliveryGetPayload extends ICorrelationPayload {
  id: number;
}
