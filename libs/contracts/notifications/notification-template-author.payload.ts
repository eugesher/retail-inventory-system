import { ICorrelationPayload } from '../microservices';

import { NotificationChannelEnum } from './enums';

// Wire-format command payload for `notification.template.author` (API Gateway →
// Notification). Carries a `correlationId` for log/trace correlation.
//
// Author has **create-or-edit** semantics keyed on the natural triple
// `(eventType, channel, locale)`: the use case derives the next `version`
// (`(maxVersion ?? 0) + 1`) and appends a brand-new `active` row at that version,
// leaving every prior version retained (the edit history). There is no separate
// "edit" command — an edit is just authoring a higher version (ADR-033).
//
// `subject` is optional on the wire because it is channel-specific: it is required
// for `email`/`webhook` (the aggregate's `create` enforces it, surfacing
// `NOTIFICATION_TEMPLATE_SUBJECT_REQUIRED` → 400) and optional for `sms`/`push`.
export interface INotificationTemplateAuthorPayload extends ICorrelationPayload {
  eventType: string;
  channel: NotificationChannelEnum;
  locale: string;
  subject?: string;
  body: string;
}
