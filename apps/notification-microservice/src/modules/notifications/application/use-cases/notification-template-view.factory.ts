import { NotificationTemplateView } from '@retail-inventory-system/contracts';

import { NotificationTemplate } from '../../domain';

// Pure mapping from the `NotificationTemplate` aggregate onto the wire
// `NotificationTemplateView`. Kept framework-free and shared across every template
// use case (author / set-active / list), so the projection lives in exactly one
// place — the `category-view.factory.ts` pattern.
//
// The aggregate is always persisted when it reaches the factory (the use cases map
// only post-`save` / post-`findById` / post-`list` aggregates), so `id` is concrete —
// the `!` reflects that invariant. `createdAt` / `updatedAt` are serialized to ISO
// strings (the wire carries strings; `null` when the row has not been timestamped,
// which never happens for a persisted row but keeps the projection total).
export const toNotificationTemplateView = (
  template: NotificationTemplate,
): NotificationTemplateView => ({
  id: template.id!,
  eventType: template.eventType,
  channel: template.channel,
  locale: template.locale,
  subject: template.subject,
  body: template.body,
  version: template.version,
  active: template.active,
  createdAt: template.createdAt ? template.createdAt.toISOString() : null,
  updatedAt: template.updatedAt ? template.updatedAt.toISOString() : null,
});
