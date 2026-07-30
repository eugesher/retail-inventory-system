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
// - `listRetryable` is the retry sweeper's scan, and it has **two arms**:
//     * `status = failed AND attempt_count < maxAttempts` — the ordinary recorded failure;
//     * `status = queued AND created_at < queuedStaleBefore` — a row ORPHANED between the
//       persist and the dispatch (see `queued-staleness.ts` for why one exists and why the
//       horizon is a threshold rather than "any queued row").
//   Both are served by the `(status, last_attempt_at)` index on their `status` prefix; the
//   queued arm's `created_at` bound is a filter on top, which costs nothing because a healthy
//   system holds a `queued` row for the milliseconds of one dispatch — orphans are the only
//   ones that linger.
//   Ordered oldest-attempt-first and capped at `limit`. A queued row has a NULL
//   `last_attempt_at`, and MySQL sorts NULLs FIRST ascending, so orphans lead the batch —
//   which is the right priority: a `failed` row is a notification we know was attempted, an
//   orphan may never have been sent at all.
//   It returns a bounded batch (not a page): the sweeper only iterates the rows and never
//   needs a full match count, so it skips the `COUNT(*)` the paged `list` pays.
// - `deleteOlderThan` is **the port's only destructive verb, and it is a deliberate one** (ISSUE-08).
//   Until it existed this seam was append-and-update-only, and `notification_delivery` grew for the
//   life of the deployment: a row per notification on the hot path of every order, fulfillment,
//   return and refund, never soft-deleted (`deletedAt` is inert **by design** — the row is the source
//   of truth for *"did we already send this?"*) and never hard-deleted, because there was no sweep.
//   `RETENTION_DELIVERY_DAYS` named the purge and **nothing read it.**
//
//   **A HARD delete, and it must be.** Soft-deleting is the tempting shortcut and it is wrong: the
//   row **is** the dedupe anchor (the generated `delivery_dedupe_key`), so a soft-deleted row that
//   the dedupe query no longer sees means the same notification is sent **twice**. There is no third
//   option — hard delete, or nothing.
//
//   **The retention horizon and the dedupe guarantee are therefore COUPLED, and that is a decision,
//   not an accident.** Purging a row past the horizon retires its dedupe anchor: an event re-processed
//   after that point would dispatch a *second* notification. It is safe because RabbitMQ will not
//   redeliver a 90-day-old message — but it is safe *by that argument*, and if the horizon is ever
//   shortened to something a broker CAN outlive, this stops being true.
//
//   Bounded by `limit` so one sweep can never take a table-sized lock; the scheduler simply runs
//   again. Returns the row count so the sweep can log real churn.
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
  listRetryable(
    maxAttempts: number,
    limit: number,
    queuedStaleBefore: Date,
  ): Promise<NotificationDelivery[]>;
  deleteOlderThan(horizon: Date, limit: number): Promise<number>;
}
