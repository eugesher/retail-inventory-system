import { ICorrelationPayload } from '../microservices';

import { NotificationDeliveryStatusEnum } from './enums';

// Wire-format query payload for `notification.delivery.list` (API Gateway →
// Notification). Carries a `correlationId` for log/trace correlation.
//
// The paginated, filterable audit read of the `notification_delivery` trail. Every
// filter field is optional and narrows the scan — an absent field widens it (no
// filter ⇒ every delivery, newest-first). `customerId` maps onto the row's
// `recipient_customer_id` (the per-customer history read); `eventReferenceType` /
// `eventReferenceId` scope to one business event (`order` / `return-request` /
// `stock-low` / `fulfillment` / `refund` + its id); `status` scopes to one
// lifecycle state.
//
// `page` is 1-based and `pageSize` is the page length — both optional here (the
// gateway DTO defaults them at the edge, the use case defaults them again as a
// backstop). The response reuses the root-barrel `IPage<NotificationDeliveryView>`
// — the canonical paged envelope, named only in app-layer code (the use case + the
// gateway), so no cross-area contract import is needed (ADR-033).
export interface INotificationDeliveryListPayload extends ICorrelationPayload {
  customerId?: string;
  eventReferenceType?: string;
  eventReferenceId?: string;
  status?: NotificationDeliveryStatusEnum;
  page?: number;
  pageSize?: number;
}
