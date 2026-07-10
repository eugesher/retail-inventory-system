export const TRACE_DOMAIN_EVENT_READER = Symbol('TRACE_DOMAIN_EVENT_READER');

// The audit-log context's read seam onto the `domain_event` table, which the SIBLING
// `domain-events/` module owns.
//
// The correlation trace (ADR-039) must return both logs for one request, but
// `TraceByCorrelationUseCase` lives in this module and `eslint-plugin-boundaries` forbids it
// from injecting the sibling module's repository-port token, or from importing its
// `DomainEvent` model / `DomainEventEntity` (ADR-017). Rather than weaken the rule, the trace
// reaches the table the way this codebase already reaches across three other such lines — a
// raw-PARAMETERIZED-SQL reader port: `ORDER_CART_READER` (orders → the cart tables),
// `RETURN_ORDER_READER` (returns → the order tables), `CONSENT_READER` (notification → the
// gateway-owned `consent_record`). The table name is the only coupling; the `?` placeholder
// is bound by the driver, never string-concatenated.
//
// Both modules live in the same `ris_eventstore` schema and on the same connection, so this
// is a single-database read — no join is lost and no second connection is opened.

// A PLAIN row shape. It deliberately does NOT reuse the sibling module's `DomainEvent`
// model: leaking that class through the port would re-couple the two modules by type after
// the boundaries rule decoupled them by import. `occurredAt` is a `Date` here (the driver
// hands back a `Date` for a `TIMESTAMP` column); the use case projects it to the wire's
// ISO-8601 string.
//
// `correlationId` is typed nullable to mirror the wire view, though the column is
// `NOT NULL DEFAULT ''` — a row reached by this read matched a non-empty id by definition.
export interface ITraceDomainEventRow {
  id: number;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  eventVersion: string;
  producer: string;
  correlationId: string | null;
  occurredAt: Date;
}

export interface ITraceDomainEventReaderPort {
  // Every firehose event belonging to one request's causal chain, ordered
  // `occurred_at ASC, id ASC` — a timeline reads forward. Unpaginated: a correlation id
  // scopes one request, so the set is bounded. A correlation id with no events yields `[]`,
  // never an error — the absence of a trace is not the absence of a resource.
  listByCorrelationId(correlationId: string): Promise<ITraceDomainEventRow[]>;
}
