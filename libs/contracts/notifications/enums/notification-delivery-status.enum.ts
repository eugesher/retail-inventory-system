// The legal transitions. The `NotificationDelivery` aggregate enforces them, but it lives in
// another service — a gateway consumer of this enum cannot reach it, so the machine is written
// out here:
//
//   QUEUED  → SENT       the NOTIFIER accepted the message
//   QUEUED  → FAILED     the NOTIFIER rejected it — retryable
//   FAILED  → SENT       a retry succeeded
//   FAILED  → FAILED     a retry failed again; `attemptCount` keeps climbing
//   SENT    → DELIVERED  a downstream receipt confirmed it landed
//   SENT    → BOUNCED    a downstream bounce notice
//
// `DELIVERED` and `BOUNCED` are terminal, and a delivery row is never deleted — it is the source
// of truth for "did we already send this?"
//
// `SKIPPED_NO_CONSENT` is **terminal and set at row creation**: it is not reachable from `QUEUED`
// at all. The Render & Dispatch consent gate (ADR-037) writes the row directly in this status
// when the channel is unconsented, recording what *would* have been sent for the audit trail
// while never calling the transport — so `attemptCount` stays `0`. It takes part in the dedupe
// key, so a redelivery collapses onto the same skipped row rather than opening a second one.
export enum NotificationDeliveryStatusEnum {
  QUEUED = 'queued',
  SENT = 'sent',
  DELIVERED = 'delivered',
  FAILED = 'failed',
  BOUNCED = 'bounced',
  SKIPPED_NO_CONSENT = 'skipped-no-consent',
}
