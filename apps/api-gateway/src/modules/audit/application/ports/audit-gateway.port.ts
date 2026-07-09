import {
  AuditLogEntryView,
  DomainEventView,
  IAuditLogQueryFilters,
  IAuditLogQueryPayload,
  ICorrelationTracePayload,
  ICorrelationTraceResult,
  IDomainEventQueryFilters,
  IDomainEventQueryPayload,
  IPage,
} from '@retail-inventory-system/contracts';

export const AUDIT_GATEWAY_PORT = Symbol('AUDIT_GATEWAY_PORT');

// Business-shaped query inputs for the gateway audit port. They deliberately omit
// `correlationId` — that is a transport concern threaded separately from the
// request, folded onto the wire payload inside the use case (the same split every
// other gateway port follows).
//
// `filters` stays NESTED rather than flattened. `ICorrelationPayload` already owns a
// top-level `correlationId`: the trace id of the request ASKING the question. A
// `filters.correlationId` is a filter VALUE: the id being searched FOR. Two unrelated
// meanings, two field positions.

// The firehose read — "what did the system do".
export interface IQueryEventsQuery {
  filters: IDomainEventQueryFilters;
  page?: number;
  pageSize?: number;
}

// The staff-audit read — "what did a person do".
export interface IQueryEntriesQuery {
  filters: IAuditLogQueryFilters;
  page?: number;
  pageSize?: number;
}

// The causal-chain read — "what did this one request cause". `targetCorrelationId` is
// the id being traced, never the id of the tracing request.
export interface ITraceByCorrelationQuery {
  targetCorrelationId: string;
}

// The gateway-side seam onto the event store's three `audit.*` query RPCs
// (`audit.event.query` / `audit.entry.query` / `audit.trace.by-correlation`, ADR-039).
// The concrete implementation (`AuditRabbitmqAdapter`) is the only holder of a
// `ClientProxy`; use cases and the controller depend on this interface (ADR-009).
//
// Each method takes the FULL wire payload — the use case has already folded the
// request's `correlationId` onto it — so the adapter sends it verbatim, exactly as
// `IInventoryGatewayPort.listVariantMovements` does. Methods return the event store's
// own `lib-contracts` view shapes unchanged.
//
// Neither read is capped here. `pageSize` is clamped into `[1, 100]` by the event
// store's use case, in one place, so a direct RPC caller inherits the same ceiling
// (ADR-039). A gateway-side copy would be a second number that drifts.
export interface IAuditGatewayPort {
  // Filtered, paginated, NEWEST-FIRST page of the `domain_event` firehose log.
  // An unmatched filter set is a `200` empty page, never a `404`.
  queryEvents(payload: IDomainEventQueryPayload): Promise<IPage<DomainEventView>>;
  // Filtered, paginated, NEWEST-FIRST page of the `audit_log_entry` staff trail.
  queryEntries(payload: IAuditLogQueryPayload): Promise<IPage<AuditLogEntryView>>;
  // The two logs for one correlation id, each ordered FORWARD in time and returned as
  // its own array. Unpaginated — a correlation id scopes one bounded causal chain.
  // An unknown id yields two empty arrays, never a `404`.
  traceByCorrelation(payload: ICorrelationTracePayload): Promise<ICorrelationTraceResult>;
}
