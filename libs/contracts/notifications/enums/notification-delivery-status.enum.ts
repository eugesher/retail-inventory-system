// A `NotificationDelivery`'s lifecycle axis — the audit trail of one outgoing
// notification as it moves from enqueued through the wire transport's outcome.
//
// It is a wire contract (not an internal domain enum) because it surfaces on
// `NotificationDeliveryView` and is mapped to the `notification_delivery.status`
// ENUM column, so it lives in `libs/contracts` where both the notification
// microservice and the gateway read it (the `ReturnStatusEnum` / `OrderStatusEnum`
// precedent, ADR-005).
//
// The transitions (enforced by the `NotificationDelivery` aggregate):
//   QUEUED  → SENT       (the NOTIFIER accepted the message)
//   QUEUED  → FAILED     (the NOTIFIER rejected it — retryable)
//   FAILED  → SENT       (a later retry succeeded)
//   FAILED  → FAILED     (a later retry failed again — attemptCount keeps climbing)
//   SENT    → DELIVERED  (a downstream delivery receipt confirmed it landed)
//   SENT    → BOUNCED    (a downstream bounce notice — terminal)
// `DELIVERED` and `BOUNCED` are terminal. A delivery row is never deleted; it is
// the source of truth for "did we already send this?" (`deleted_at` inert).
export enum NotificationDeliveryStatusEnum {
  QUEUED = 'queued',
  SENT = 'sent',
  DELIVERED = 'delivered',
  FAILED = 'failed',
  BOUNCED = 'bounced',
}
