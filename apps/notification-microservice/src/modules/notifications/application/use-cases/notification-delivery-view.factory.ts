import { NotificationDeliveryView } from '@retail-inventory-system/contracts';

import { NotificationDelivery } from '../../domain';

// Pure mapping from the `NotificationDelivery` aggregate onto the wire
// `NotificationDeliveryView`. Kept framework-free and shared across every delivery
// read (list / get / record-outcome), so the projection lives in exactly one place
// — the `notification-template-view.factory.ts` pattern.
//
// The aggregate is always persisted when it reaches the factory (the use cases map
// only post-`save` / post-`findById` / post-`list` aggregates), so `id` is concrete
// — the `!` reflects that invariant. The three `Date` fields (`lastAttemptAt` /
// `createdAt` / `updatedAt`) serialize to ISO strings (the wire carries strings),
// preserving `null` (a `queued` row has never been attempted, so `lastAttemptAt` is
// null).
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
