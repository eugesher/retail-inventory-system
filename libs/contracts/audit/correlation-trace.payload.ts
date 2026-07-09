import { ICorrelationPayload } from '../microservices';

import { AuditLogEntryView } from './audit-log-entry.view';
import { DomainEventView } from './domain-event.view';

// Wire-format payload for `audit.trace.by-correlation` (API Gateway → event store) — the
// causal chain of one request across every service that touched it
// (docs/adr/039-audit-and-event-store-query-surface.md).
export interface ICorrelationTracePayload extends ICorrelationPayload {
  // The correlation id being traced. Deliberately NOT named `correlationId`: the inherited
  // field already carries the trace id of the *request asking the question*, which is a
  // different id with a different meaning. Overloading one name for both would make every
  // log line ambiguous.
  //
  // An empty string is rejected at the gateway DTO: `domain_event.correlation_id` is
  // `NOT NULL DEFAULT ''`, so `''` is the sentinel for "ingested without a correlation id"
  // and would match every such row rather than none.
  targetCorrelationId: string;
}

// The trace result: two independently-ordered timelines, never merged into one.
//
// Both arrays read FORWARD — `occurredAt` ascending, `id` ascending as the tiebreaker for
// rows sharing a millisecond. Neither is paginated: a correlation id scopes exactly one
// request's causal chain, which is bounded and small.
//
// An unknown correlation id yields two empty arrays, never a `404`. The absence of a trace is
// not the absence of a resource.
export interface ICorrelationTraceResult {
  events: DomainEventView[];
  auditEntries: AuditLogEntryView[];
}
