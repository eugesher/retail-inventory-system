import { Inject, Injectable } from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';

import {
  DomainEventView,
  ICorrelationTracePayload,
  ICorrelationTraceResult,
} from '@retail-inventory-system/contracts';

import {
  AUDIT_LOG_REPOSITORY,
  IAuditLogRepositoryPort,
  ITraceDomainEventReaderPort,
  ITraceDomainEventRow,
  TRACE_DOMAIN_EVENT_READER,
} from '../ports';
import { toAuditLogEntryView } from './audit-log-entry-view.factory';

// Trace By Correlation: the causal chain of ONE request across every service that touched it
// (ADR-039). It returns both logs the event store keeps — the firehose events the system
// emitted, and the audit entries a staff principal caused — as two independently-ordered
// timelines, never merged into one.
//
// **Unpaginated and ascending.** A correlation id scopes exactly one request, so the result
// set is bounded and small: there is nothing to page. And a timeline reads FORWARD, the
// opposite of the newest-first order the two paginated audit queries want. Ordering is owned
// by the two seams, both of which promise `occurred_at ASC, id ASC`.
//
// **An unknown correlation id returns two empty arrays, never a 404.** The absence of a trace
// is not the absence of a resource — the id may name a request that emitted nothing, or one
// whose events have not been ingested yet.
//
// The cross-module read: `domain_event` belongs to the sibling `domain-events/` module, and
// `eslint-plugin-boundaries` forbids this use case from injecting that module's repository-port
// token (ADR-017). It reaches the table through `TRACE_DOMAIN_EVENT_READER` — a raw-parameterized-SQL
// reader port, the seam `ORDER_CART_READER`, `RETURN_ORDER_READER`, and `CONSENT_READER`
// established. The two reads touch different tables, so they run concurrently.
//
// One column fact this use case cannot paper over: `domain_event.correlation_id` is
// `NOT NULL DEFAULT ''` (the ingest dedupe UNIQUE would otherwise be defeated by MySQL's
// distinct-NULLs rule), so an event ingested with no correlation id stored `''` and is
// unreachable by any trace. `audit_log_entry.correlation_id` is nullable, and a null row is
// likewise matched by no id. Both are by design.
@Injectable()
export class TraceByCorrelationUseCase {
  constructor(
    @Inject(AUDIT_LOG_REPOSITORY)
    private readonly auditLogRepository: IAuditLogRepositoryPort,
    @Inject(TRACE_DOMAIN_EVENT_READER)
    private readonly domainEventReader: ITraceDomainEventReaderPort,
    @InjectPinoLogger(TraceByCorrelationUseCase.name)
    private readonly logger: PinoLogger,
  ) {}

  public async execute(payload: ICorrelationTracePayload): Promise<ICorrelationTraceResult> {
    const { targetCorrelationId, correlationId } = payload;

    // `correlationId` is the id of the request ASKING; `targetCorrelationId` is the id being
    // traced. Both go on the log line precisely because they are easy to confuse.
    this.logger.info(
      { correlationId, targetCorrelationId },
      'Received RPC: trace by correlation id (cross-log causal chain)',
    );

    // The gateway DTO rejects a blank target, but this RPC is directly reachable on the bus.
    // An absent one must not reach the reads: TypeORM DROPS an `undefined` value from a
    // `where` clause rather than matching nothing, so `listByCorrelationId(undefined)` would
    // degrade into an unbounded `SELECT *` over the whole audit trail. `''` is no better —
    // it is the stored sentinel for "ingested without a correlation id"
    // (`domain_event.correlation_id` is `NOT NULL DEFAULT ''`), so it would return that
    // entire bucket rather than one request's chain (ADR-039 §6). Neither names a request,
    // and an id that names no request traces to two empty arrays — the same answer an
    // unknown id gets.
    if (typeof targetCorrelationId !== 'string' || targetCorrelationId.trim() === '') {
      this.logger.warn(
        { correlationId },
        'Trace by correlation id: blank target — returning an empty trace',
      );
      return { events: [], auditEntries: [] };
    }

    // Two different tables, so no ordering constraint binds them — issue both at once.
    const [events, auditEntries] = await Promise.all([
      this.domainEventReader.listByCorrelationId(targetCorrelationId),
      this.auditLogRepository.listByCorrelationId(targetCorrelationId),
    ]);

    return {
      events: events.map((row) => TraceByCorrelationUseCase.toDomainEventView(row)),
      auditEntries: auditEntries.map(toAuditLogEntryView),
    };
  }

  // Projects the reader port's plain row onto the wire view. This deliberately does NOT reuse
  // the sibling module's `toDomainEventView` factory: that factory takes the sibling's
  // `DomainEvent` model, and importing either would cross the same isolation line the reader
  // port exists to respect. The projection is a rename-free field copy plus the `Date` →
  // ISO-8601 conversion the wire needs (the returns module's local copy of
  // `retry-then-log-for-replay.ts` is the same trade: a few duplicated lines beat a broken
  // boundary).
  private static toDomainEventView(row: ITraceDomainEventRow): DomainEventView {
    return {
      id: row.id,
      eventType: row.eventType,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      payload: row.payload,
      eventVersion: row.eventVersion,
      producer: row.producer,
      correlationId: row.correlationId,
      occurredAt: row.occurredAt.toISOString(),
    };
  }
}
