import { Module } from '@nestjs/common';

import { DatabaseModule } from '@retail-inventory-system/database';

import {
  IngestAuditLogUseCase,
  QueryAuditLogEntriesUseCase,
  TraceByCorrelationUseCase,
} from '../application/use-cases';
import { AUDIT_LOG_REPOSITORY, TRACE_DOMAIN_EVENT_READER } from '../application/ports';
import {
  AuditLogEntryEntity,
  AuditLogEntryTypeormRepository,
  TraceDomainEventReader,
} from './persistence';

// The `audit-log` module of the event store's `audit-and-events` context — the staff
// audit trail (who did what, when, ADR-035), distinct from the raw event firehose the
// sibling `domain-events/` module sinks. It owns the append-only `audit_log_entry`
// table (ADR-034 isolated `ris_eventstore` schema), and — with the query surface, ADR-039 —
// the cross-log correlation trace.
//
// `DatabaseModule.forFeature([AuditLogEntryEntity])` registers the entity against the
// eventstore connection; `AUDIT_LOG_REPOSITORY` is bound to its append-only TypeORM
// adapter. `IngestAuditLogUseCase` is provided AND EXPORTED so the context-root
// `FirehoseConsumer` can inject it for the `audit.staff.action` branch of its dispatch —
// the use case stays inside its owning module, the cross-module dispatcher resolves it
// through this export. The two read use cases are exported for the same reason.
//
// `TRACE_DOMAIN_EVENT_READER` is bound here to `TraceDomainEventReader`, a raw-SQL adapter
// over the sibling module's `domain_event` table. `TraceByCorrelationUseCase` needs those
// rows and may not inject the sibling module's repository-port token (ADR-017) — the reader
// port is the seam that keeps the boundary intact. Its `EntityManager` comes from the
// connection `DatabaseModule.forFeature` already registered against this module.
@Module({
  imports: [DatabaseModule.forFeature([AuditLogEntryEntity])],
  providers: [
    { provide: AUDIT_LOG_REPOSITORY, useClass: AuditLogEntryTypeormRepository },
    { provide: TRACE_DOMAIN_EVENT_READER, useClass: TraceDomainEventReader },
    IngestAuditLogUseCase,
    QueryAuditLogEntriesUseCase,
    TraceByCorrelationUseCase,
  ],
  exports: [
    AUDIT_LOG_REPOSITORY,
    IngestAuditLogUseCase,
    QueryAuditLogEntriesUseCase,
    TraceByCorrelationUseCase,
  ],
})
export class AuditLogModule {}
