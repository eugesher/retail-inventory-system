import {
  NotificationChannelEnum,
  NotificationDeliveryStatusEnum,
} from '@retail-inventory-system/contracts';

import { NotificationDelivery } from '../../domain';

export const NOTIFICATION_DELIVERY_REPOSITORY = Symbol('NOTIFICATION_DELIVERY_REPOSITORY');

// Filter for the delivery audit read. Every field is optional — an absent field widens
// the scan. Backs the per-customer / per-event / per-status history reads.
export interface INotificationDeliveryListFilter {
  status?: NotificationDeliveryStatusEnum;
  channel?: NotificationChannelEnum;
  eventReferenceType?: string;
  eventReferenceId?: string;
  recipientCustomerId?: string;
}

// Pagination is declared **locally** here, not imported from `libs/common`'s `IPage` /
// `IPageRequest` — an `application-port` may not depend on `lib-common` (the
// `eslint-plugin-boundaries` rule, ADR-017), so the port owns its own page shapes (the
// inventory `IStockMovementPage` precedent). `page` is 1-based.
export interface INotificationDeliveryPageRequest {
  page: number;
  size: number;
}

export interface INotificationDeliveryPage {
  items: NotificationDelivery[];
  total: number;
  page: number;
  size: number;
}

// The repository seam for the `NotificationDelivery` audit trail. Returns domain types
// only — no TypeORM leak here (ADR-017); the TypeORM details live entirely in
// `NotificationDeliveryTypeormRepository`.
//
// The contract the Render & Dispatch / Record Outcome / Retry / read operations depend
// on:
// - `save` upserts one delivery row and re-reads it concrete. On the **double-dispatch
//   race** (two consumers handling the same event both INSERT a customer-facing row),
//   the loser's INSERT collides with the `UC_NOTIFICATION_DELIVERY_DEDUPE` unique index
//   on the generated `delivery_dedupe_key`; `save` catches that `ER_DUP_ENTRY` and
//   re-loads the winner's row via the dedupe components, returning it (idempotent — the
//   `ReservationTypeormRepository` ER_DUP_ENTRY-translation precedent). System/ops rows
//   (`recipientCustomerId IS NULL`) carry a null dedupe key and are never deduped.
// - `findByDedupeKey` is the explicit idempotency pre-check the dispatch use case runs
//   BEFORE opening a row (skip if a delivery already exists for the
//   `(templateId, eventReferenceType, eventReferenceId, channel, recipientCustomerId)`
//   tuple). `templateId` is part of the scope so two distinct event types sharing one
//   business reference (the `retail.return.*` family on one `rmaId`) are not collapsed.
//   A null `recipientCustomerId` is not a dedupe scope, so this is only meaningful for
//   customer-facing notifications.
// - `findById` is the by-id load path (Record Outcome / Retry resolve a delivery by id).
// - `list` is the paged, filtered audit read (newest-first).
// - `listRetryable` is the retry sweeper's scan: `status = failed AND attempt_count <
//   maxAttempts`, oldest-attempt-first, capped at `limit` — served by the
//   `(status, last_attempt_at)` index. It returns a bounded batch (not a page): the
//   sweeper only iterates the rows and never needs a full match count, so it skips the
//   `COUNT(*)` the paged `list` pays.
export interface INotificationDeliveryRepositoryPort {
  save(delivery: NotificationDelivery): Promise<NotificationDelivery>;
  findById(id: number): Promise<NotificationDelivery | null>;
  findByDedupeKey(
    templateId: number,
    eventReferenceType: string,
    eventReferenceId: string,
    channel: NotificationChannelEnum,
    recipientCustomerId: string,
  ): Promise<NotificationDelivery | null>;
  list(
    filter: INotificationDeliveryListFilter,
    page: INotificationDeliveryPageRequest,
  ): Promise<INotificationDeliveryPage>;
  listRetryable(maxAttempts: number, limit: number): Promise<NotificationDelivery[]>;
}
