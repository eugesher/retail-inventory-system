import { IDomainEventQueryFilters, IPage } from '@retail-inventory-system/contracts';

import { DomainEvent } from '../../domain';

export const DOMAIN_EVENT_REPOSITORY = Symbol('DOMAIN_EVENT_REPOSITORY');

// The outcome of an append: `inserted` is `true` when the row was written, `false`
// when the composite-UNIQUE idempotency key collided with an already-stored event
// (a RabbitMQ redelivery — ADR-020 is at-least-once). The caller never sees a thrown
// duplicate; the swallow is the idempotency guarantee.
export interface IDomainEventAppendResult {
  inserted: boolean;
}

// The applied page window. Pagination is declared LOCALLY here rather than imported from
// `libs/common`'s `IPageRequest` — an `application-port` may not depend on `lib-common`
// (the `eslint-plugin-boundaries` rule, ADR-017), so the port owns its own page-request
// shape (the `INotificationDeliveryPageRequest` / `IStockMovementPage` precedent). It is
// structurally identical to `clampPageWindow`'s return value, which is what the query use
// case passes. `page` is 1-based.
export interface IDomainEventPageRequest {
  page: number;
  size: number;
}

// The ENTIRE repository surface for the firehose log — `append` + `query`, and NOTHING
// else. There is deliberately no `save` / `update` / `delete`: the `domain_event` log is
// append-only (the audit-integrity / "never delete, never update" cross-cutting rule),
// and that invariant is enforced HERE, in the port's type surface, not merely by
// convention — an UPDATE or DELETE is not expressible against this seam. Domain types
// only — no `typeorm` leak (ADR-017).
export interface IDomainEventRepositoryPort {
  // INSERT a captured firehose event. On the composite-UNIQUE
  // `(producer, event_type, aggregate_id, occurred_at, correlation_id)` collision the
  // implementation returns `{ inserted: false }` (an idempotent no-op — the
  // `ReservationTypeormRepository` `ER_DUP_ENTRY`-translation precedent), never
  // throwing, so a redelivery is silently absorbed.
  append(event: DomainEvent): Promise<IDomainEventAppendResult>;

  // The paginated, filtered audit read (ADR-039). Ordering is owned HERE, not by the
  // caller: `occurred_at DESC, id DESC` — newest-first, because the operator's default
  // question is "what just happened", and the `id` tiebreaker totalises the order when two
  // events share a millisecond. Every supplied filter contributes one predicate over an
  // INDEXED column; an absent filter contributes none, so an empty filter reads the whole
  // log. `from` / `to` bound `occurred_at` inclusively; an inverted range simply selects
  // nothing (no exception — the event store grows no domain-exception type for it).
  //
  // There is deliberately NO `listByCorrelationId` here. `query({ correlationId }, page)`
  // covers the paginated case, and the unpaginated correlation TRACE reaches this table
  // through the audit-log module's `TRACE_DOMAIN_EVENT_READER` seam instead — a second
  // read on this port would be a dead one.
  query(
    filters: IDomainEventQueryFilters,
    page: IDomainEventPageRequest,
  ): Promise<IPage<DomainEvent>>;
}
