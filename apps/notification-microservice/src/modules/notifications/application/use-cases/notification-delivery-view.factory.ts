import { NotificationDeliveryView } from '@retail-inventory-system/contracts';

import { NotificationDelivery } from '../../domain';

export const toNotificationDeliveryView = (
  delivery: NotificationDelivery,
): NotificationDeliveryView => ({
  id: delivery.id!,
  templateId: delivery.templateId,
  recipientCustomerId: delivery.recipientCustomerId,
  recipientAddress: delivery.recipientAddress,
  channel: delivery.channel,
  eventReferenceType: delivery.eventReferenceType,
  eventReferenceId: delivery.eventReferenceId,
  status: delivery.status,
  attemptCount: delivery.attemptCount,
  lastAttemptAt: delivery.lastAttemptAt ? delivery.lastAttemptAt.toISOString() : null,
  failureReason: delivery.failureReason,
  renderedSubject: delivery.renderedSubject,
  renderedBody: delivery.renderedBody,
  correlationId: delivery.correlationId,
  createdAt: delivery.createdAt ? delivery.createdAt.toISOString() : null,
  updatedAt: delivery.updatedAt ? delivery.updatedAt.toISOString() : null,
});
