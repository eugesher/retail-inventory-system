import { NotificationTemplateView } from '@retail-inventory-system/contracts';

import { NotificationTemplate } from '../../domain';

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
