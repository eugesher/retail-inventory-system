import { ICorrelationPayload } from '../microservices';

// Wire-format command payload for `notification.marketing.send` (API Gateway →
// Notification, ADR-037) — the staff-triggered marketing dispatch. The gateway resolves
// the defaults and mints the `campaignId` at the HTTP edge, so this payload is fully
// formed by the time it reaches the notification service.
//
// - `customerId`      — the recipient customer's CHAR(36) UUID; also the consent-gate's
//                        lookup key AND the delivery's dedupe anchor.
// - `customerEmail`   — the resolved recipient address (an operator-supplied input, so
//                        the gateway need not cross the auth-module boundary to read it).
// - `eventType`       — the marketing template registry key (default `marketing.email.promo`);
//                        it MUST NOT be a transactional event type or the consent-gate
//                        would treat the send as transactional.
// - `campaignId`      — the per-send reference id (minted per HTTP request at the gateway).
//                        It becomes the delivery's `eventReferenceId`, so it must vary per
//                        distinct send: a redelivery of THIS message carries the same id and
//                        dedups, but a new operator send gets a fresh id and is a new row.
// - `context`         — the Handlebars render context for the marketing template.
export interface INotificationMarketingSendPayload extends ICorrelationPayload {
  customerId: string;
  customerEmail: string;
  eventType: string;
  campaignId: string;
  context: Record<string, unknown>;
}
