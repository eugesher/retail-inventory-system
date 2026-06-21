import { ICorrelationPayload } from '../microservices';

import { NotificationChannelEnum } from './enums';

// Wire-format query payload for `notification.template.list` (API Gateway →
// Notification). Carries a `correlationId` for log/trace correlation.
//
// The registry browse: every field is optional and narrows the scan — an absent
// field widens it (no filter ⇒ every template, every version, active or not). The
// registry is small and staff-facing, so the read is unpaginated. The result is a
// `NotificationTemplateView[]` (ADR-033).
export interface INotificationTemplateListPayload extends ICorrelationPayload {
  eventType?: string;
  channel?: NotificationChannelEnum;
  locale?: string;
}
