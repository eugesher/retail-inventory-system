import { ICorrelationPayload } from '../microservices';

// The filter set for the `audit.event.query` read of the `domain_event` firehose log
// (docs/adr/039-audit-and-event-store-query-surface.md). Every field is optional and
// NARROWS the scan; an absent field contributes no predicate, so an empty filter lists the
// whole log, newest-first.
//
// Every filter names an INDEXED column. There is deliberately no free-text or JSON-path
// search over `payload`: an unindexable predicate over an ever-growing append-only table
// degrades into a full scan (ADR-039).
//
// `from` / `to` bound `occurredAt` INCLUSIVELY. An inverted range (`from > to`) selects
// nothing and yields an empty page — the event store raises no domain exception for it.
export interface IDomainEventQueryFilters {
  // The full dotted routing key the event was published under, e.g. `retail.order.placed`.
  eventType?: string;
  // The routing key's second token, e.g. `order` — the coarse "which kind of thing" axis.
  aggregateType?: string;
  aggregateId?: string;
  // Matches `domain_event.correlation_id`, which is `NOT NULL DEFAULT ''`. An event ingested
  // with no correlation id stored `''` and is therefore matched by no value a caller can
  // meaningfully pass.
  correlationId?: string;
  from?: string; // inclusive ISO-8601 lower bound on occurredAt
  to?: string; // inclusive ISO-8601 upper bound on occurredAt
}

// Wire-format query payload for `audit.event.query` (API Gateway → event store).
//
// **The filters are nested for a reason.** `ICorrelationPayload` already owns a top-level
// `correlationId` — the *request's* trace id, threaded by `CorrelationMiddleware`. The
// query's `correlationId` is a *filter value*: the id being searched for. Flattening the two
// would put two unrelated meanings on one field name. Never rename the correlation payload's
// field; nest the filters instead.
//
// `page` is 1-based and `pageSize` is the page length — both optional (the use case clamps
// them: defaults 1 / 20, hard cap 100). The response is the canonical root-barrel
// `IPage<DomainEventView>` — `{ items, total, page, size }`; note the wire asks for
// `pageSize` and the page answers with `size`, exactly as `inventory.stock-movement.list`
// already does.
export interface IDomainEventQueryPayload extends ICorrelationPayload {
  filters: IDomainEventQueryFilters;
  page?: number;
  pageSize?: number;
}
